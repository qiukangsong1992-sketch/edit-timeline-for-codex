import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface CodexHookEvent {
  hook_event_name: 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse';
  cwd?: string;
  session_id?: string;
  turn_id?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  bridge_started_at?: number;
}

const descriptorDirectory = path.join(os.tmpdir(), 'edit-timeline-for-codex', 'receivers');

/** 每组工作区只开放一个带随机令牌的本机命名管道。 */
export class HookReceiver implements vscode.Disposable {
  private readonly server: net.Server;
  private readonly pipe: string;
  private readonly descriptor: string;
  private readonly token = randomBytes(32).toString('hex');
  private active = false;

  constructor(
    private readonly roots: string[],
    private readonly handle: (event: CodexHookEvent) => Promise<void>,
    private readonly log: (message: string) => void,
  ) {
    const key = createHash('sha256').update(roots.map((root) => path.resolve(root).toLowerCase()).sort().join('|')).digest('hex').slice(0, 24);
    this.pipe = `\\\\.\\pipe\\edit-timeline-for-codex-${key}`;
    this.descriptor = path.join(descriptorDirectory, `${key}.json`);
    this.server = net.createServer((socket) => {
      let input = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        input += chunk;
        if (input.length > 8 * 1024 * 1024) socket.destroy();
        const end = input.indexOf('\n');
        if (end < 0) return;
        const line = input.slice(0, end);
        input = '';
        void this.consume(line).then(() => socket.end('{"ok":true}\n'), (error: unknown) => {
          this.log(`Hook 处理失败：${describe(error)}`);
          socket.end('{"ok":false}\n');
        });
      });
    });
  }

  async start(): Promise<boolean> {
    await fs.mkdir(descriptorDirectory, { recursive: true });
    const listening = await new Promise<boolean>((resolve, reject) => {
      this.server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') resolve(false);
        else reject(error);
      });
      this.server.listen(this.pipe, () => resolve(true));
    });
    if (!listening) {
      this.log('同一工作区已有接收端，当前窗口复用现有管道');
      return false;
    }
    this.active = true;
    await fs.writeFile(this.descriptor, JSON.stringify({ pipe: this.pipe, token: this.token, roots: this.roots }), 'utf8');
    return true;
  }

  dispose(): void {
    if (this.active) this.server.close();
    if (this.active) {
      void fs.readFile(this.descriptor, 'utf8').then((value) => {
        if (JSON.parse(value).token === this.token) return fs.unlink(this.descriptor);
        return undefined;
      }).catch(() => undefined);
    }
  }

  private async consume(line: string): Promise<void> {
    const request = JSON.parse(line) as { token?: string; event?: CodexHookEvent };
    if (request.token !== this.token || !request.event) throw new Error('认证失败');
    const event = request.event;
    if ((event.hook_event_name as string) === '__ping') return;
    if (!['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(event.hook_event_name)) throw new Error('未知 Hook 事件');
    await this.handle(event);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
