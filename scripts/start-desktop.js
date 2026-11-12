#!/usr/bin/env node
/**
 * 启动 FCA Memory Atlas 桌面软件（开发/验证用）。
 * 用法：node scripts/start-desktop.js [--view=atlas|timeline|settings] [--show-capture] [--fca-home=<dir>]
 * 说明：生产安装版由安装包内的 FCA Memory Atlas.exe 启动；本脚本用于源码级运行与截图验证。
 */
import { PATHS, runElectron, timestamp } from './lib/common.js';

const args = process.argv.slice(2);
const passthrough = args.filter((a) => !a.startsWith('--fca-home='));
const fcaHomeArg = args.find((a) => a.startsWith('--fca-home='));
const env = {};
if (fcaHomeArg) env.FCA_HOME = fcaHomeArg.split('=')[1];

console.log(`[start-desktop] electron app dir: ${PATHS.desktopDir}`);
console.log(`[start-desktop] ${timestamp()}`);

const { code } = await runElectron([PATHS.desktopDir, ...passthrough], { env });
process.exit(code ?? 0);
