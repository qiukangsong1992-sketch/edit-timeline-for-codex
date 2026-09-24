# 衍生项目与依赖许可

Edit Timeline For Codex 由 Rajendra Choudhary 的 **AI Changes Timeline** 源码衍生。原作者版权声明及完整 MIT 许可保留在 [LICENSE.md](LICENSE.md)。本项目名称、Hook 采集、工作区扫描、存储与中文界面为衍生项目修改；不代表原作者为这些修改背书。

运行时不依赖第三方 npm 包。构建和测试使用 TypeScript、esbuild、ESLint、Vitest、Mocha 及 VS Code 测试工具；版本与各依赖声明见 `package-lock.json`。这些工具按各自许可证分发，本 VSIX 不打包 `node_modules`。VS Code 扩展 API 和 Node 内置模块由用户的 VS Code 运行环境提供。

`media/icon.png` 由 OpenAI imagegen 内置工具生成，提示词为“中心构图、深靛背景的文件加三节点时间线图形，无文字、无水印”。活动栏 SVG 由本项目绘制，以便适配 VS Code 主题色。
