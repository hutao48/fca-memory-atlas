/**
 * 视图模块加载器（测试专用）
 *
 * desktop/package.json 声明 "type": "commonjs"（主进程为 CJS），
 * 因此 Node 不会把 desktop/renderer 下的 .js 当作 ESM 加载。
 * 但视图模块在浏览器中是以原生 ESM 加载的，且模块顶层无 DOM 副作用。
 * 这里通过 data: URL 以 ESM 方式加载真实源文件，保证测试的是生产代码本身。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const VIEWS_DIR = join(HERE, '..', '..', '..', 'desktop', 'renderer', 'views');

export async function loadView(name) {
  const file = join(VIEWS_DIR, `${name}.js`);
  const source = readFileSync(file, 'utf8');
  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(url);
}

export function readViewSource(name) {
  return readFileSync(join(VIEWS_DIR, `${name}.js`), 'utf8');
}
