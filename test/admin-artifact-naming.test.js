// 作者: 花落, MIT License
// 回归测试：批量上传 ncnn .param/.bin 时的制品名推断
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferFormat, inferName } from '../src/routes/admin-artifacts.js';

test('ncnn .param and .bin keep distinct artifact names', () => {
  // 曾经的缺陷：正则只剥离最后一级扩展名，X.ncnn.param 与 X.ncnn.bin
  // 都塌缩为 X.ncnn，命中 uq_model_artifacts_version 唯一键导致 409。
  assert.equal(inferName('CF_INT8_192.ncnn.param'), 'CF_INT8_192.ncnn.param');
  assert.equal(inferName('CF_INT8_192.ncnn.bin'), 'CF_INT8_192.ncnn.bin');
  assert.notEqual(
    inferName('CF_INT8_192.ncnn.param'),
    inferName('CF_INT8_192.ncnn.bin'),
  );
});

test('a full ncnn batch produces no name collisions', () => {
  const games = ['CF', 'Delta', 'PUBG', 'Valorant'];
  const files = games.flatMap((game) => [192, 256].flatMap((size) => [
    `${game}_INT8_${size}.ncnn.param`,
    `${game}_INT8_${size}.ncnn.bin`,
  ]));
  const names = files.map(inferName);
  assert.equal(new Set(names).size, files.length);
});

test('single-extension formats still drop the extension', () => {
  assert.equal(inferName('screenyolo.onnx'), 'screenyolo');
  assert.equal(inferName('dw_PUBG_256_int8.tflite'), 'dw_PUBG_256_int8');
  assert.equal(inferName('model.dlc'), 'model');
  assert.equal(inferName('libnative.so'), 'libnative');
  assert.equal(inferName('classes.dex'), 'classes');
  assert.equal(inferName('weights.pt'), 'weights');
});

test('name inference is case-insensitive and leaves unknown suffixes intact', () => {
  assert.equal(inferName('Model.ONNX'), 'Model');
  assert.equal(inferName('Model.PARAM'), 'Model.PARAM');
  assert.equal(inferName('archive.tar.gz'), 'archive.tar.gz');
});

test('format inference still maps ncnn pairs to distinct formats', () => {
  assert.equal(inferFormat('CF_INT8_192.ncnn.param'), 'ncnn-param');
  assert.equal(inferFormat('CF_INT8_192.ncnn.bin'), 'ncnn-bin');
  assert.equal(inferFormat('dw_PUBG_256_int8.tflite'), 'tflite');
  assert.equal(inferFormat('libnative.so'), 'so');
});
