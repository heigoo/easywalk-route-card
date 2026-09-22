/**
 * 服务端配置（设计文档第 7.1、11.1 节）。
 * 高德 Web 服务 Key 只从服务端环境变量或本地 .env 读取，绝不进入前端与仓库。
 */

export interface ServerConfig {
  /** 高德 Web 服务 Key；未配置时为 null（路由据此返回 AMAP_NOT_CONFIGURED） */
  amapKey: string | null;
  /** 监听端口，默认 8787 */
  port: number;
}

const DEFAULT_PORT = 8787;

let envFileLoaded = false;

/**
 * 本地开发加载 .env（该文件已被 Git 忽略，示例见 .env.example）。
 * 仅在关键变量缺失时尝试，且不覆盖已存在的环境变量，避免意外覆盖部署配置。
 */
function loadLocalEnvOnce(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  if (process.env.AMAP_WEB_SERVICE_KEY) return;
  if (typeof process.loadEnvFile !== 'function') return;
  try {
    process.loadEnvFile('.env');
  } catch {
    // 没有 .env 文件或无法读取时静默跳过：未配置 Key 由路由返回 AMAP_NOT_CONFIGURED
  }
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  if (env === process.env) loadLocalEnvOnce();
  const rawKey = env.AMAP_WEB_SERVICE_KEY?.trim() ?? '';
  const rawPort = env.PORT?.trim() ?? '';
  const port = rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  return {
    amapKey: rawKey.length > 0 ? rawKey : null,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
  };
}