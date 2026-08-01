#!/usr/bin/env node
import { basename } from 'node:path';
import {
  publishModelArtifact,
  readSecretFile,
} from '../src/tools/model-artifact-publisher.js';

function parseArguments(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      result._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function usage() {
  console.log(`KMXT model artifact publisher

Usage:
  node cli/publish-model-artifact.js \\
    --api-url https://kmxt.example.com \\
    --app-id <uuid> \\
    --input <model.onnx> \\
    --output <model.onnx.enc> \\
    --version <version> \\
    --format <onnx|ncnn-param|ncnn-bin|tflite|dlc|bundle|so|dex> \\
    [--name <artifact-name>] [--edition <edition>] [--key-version <number>] \\
    [--manifest <manifest.json>] [--token-file <admin-token-file>] [--overwrite]

Authentication:
  Set KMXT_ADMIN_TOKEN or pass --token-file. A literal token argument is intentionally unsupported.

Local development:
  --allow-http permits only localhost/127.0.0.1/[::1] HTTP URLs.
`);
}

function required(value, flag) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${flag} is required`);
  return value;
}

function optionalInteger(value, flag) {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} must be an integer`);
  return parsed;
}

const args = parseArguments(process.argv.slice(2));
if (args.help || args._.includes('help')) {
  usage();
  process.exit(0);
}
if (args._.length > 0) {
  console.error(JSON.stringify({ success: false, error: { code: 'INVALID_INPUT', message: `Unexpected argument: ${args._[0]}` } }));
  process.exit(2);
}

try {
  const inputPath = required(args.input, '--input');
  const token = args['token-file']
    ? await readSecretFile(args['token-file'])
    : process.env.KMXT_ADMIN_TOKEN;
  if (!token) throw new Error('KMXT_ADMIN_TOKEN or --token-file is required');

  // Author: 花落. The CLI prints metadata only; DEKs and admin tokens stay out of logs. MIT License.
  const result = await publishModelArtifact({
    apiUrl: required(args['api-url'] ?? process.env.KMXT_API_URL, '--api-url'),
    appId: required(args['app-id'] ?? process.env.KMXT_APP_ID, '--app-id'),
    token,
    inputPath,
    outputPath: args.output ?? `${inputPath}.enc`,
    name: args.name ?? basename(inputPath),
    version: required(args.version, '--version'),
    format: required(args.format, '--format'),
    edition: args.edition,
    keyVersion: optionalInteger(args['key-version'], '--key-version'),
    timeoutMs: optionalInteger(args['timeout-ms'], '--timeout-ms'),
    manifestPath: args.manifest,
    overwrite: args.overwrite === true,
    keepCiphertextOnFailure: args['keep-ciphertext-on-failure'] === true,
    allowHttp: args['allow-http'] === true,
  });
  console.log(JSON.stringify({ success: true, data: result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    success: false,
    error: {
      code: error?.code || 'ARTIFACT_PUBLISH_FAILED',
      message: error?.message || 'Artifact publication failed',
      ...(Number.isInteger(error?.status) && error.status > 0 ? { status: error.status } : {}),
    },
  }));
  process.exitCode = 1;
}
