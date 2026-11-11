/**
 * 共享值语言——两个面都用的原子：标识、内容、模型、MCP、网页、进程、配置、诊断。
 *
 * 0.2.0 先把入口建起来；P6 再把文件物理搬进本目录。边界从今天起可断言：
 * 这里只放不依赖会话/调度方向的值与纯函数。
 */
export * from '../ids.ts'
export * from '../model.ts'
export * from '../mcp.ts'
export * from '../web.ts'
export * from '../search.ts'
export * from '../settings.ts'
export * from '../settings-codec.ts'
export * from '../diagnostics.ts'
export * from '../config.ts'
export * from '../process.ts'
