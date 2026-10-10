#!/usr/bin/env node
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/cli.ts");
const code = await main(process.argv.slice(2));
if (code >= 0) process.exitCode = code;
