// 临时调试文件：测试路由匹配逻辑
import { readFileSync } from 'fs';

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePath(pattern) {
  const parameterNames = [];
  const segments = pattern.split('/').map((segment) => {
    if (segment.startsWith(':')) {
      parameterNames.push(segment.slice(1));
      return '([^/]+)';
    }
    return escapeRegularExpression(segment);
  });
  return { expression: new RegExp(`^${segments.join('/')}/?$`), parameterNames };
}

// 测试路由
const route = compilePath('/api/v1/artifacts/:artifactId');
console.log('路由正则:', route.expression);
console.log('参数名:', route.parameterNames);

// 测试各种路径
const testPaths = [
  '/api/v1/artifacts/123',
  '/api/v1/artifacts/123/',
  '/api/v1/artifacts/abc-def-456',
  '/api/v1/artifacts/550e8400-e29b-41d4-a716-446655440000',
  '/api/v1/artifacts/abc%2Fdef',  // URL 编码的斜杠
  '/api/v1/artifacts/',           // 空 ID
  '/api/v1/artifacts',            // 无尾随斜杠
];

console.log('\n测试匹配结果:');
testPaths.forEach((path) => {
  const match = route.expression.exec(path);
  console.log(`路径: ${path}`);
  console.log(`  匹配: ${match ? 'YES' : 'NO'}`);
  if (match) {
    console.log(`  提取参数: artifactId = "${match[1]}"`);
  }
  console.log('');
});

// 读取实际数据查看 artifact ID 格式
try {
  const storeData = JSON.parse(readFileSync('./data/store.json', 'utf8'));
  const artifacts = storeData.modelArtifacts || [];
  console.log('\n实际 artifact ID 格式 (前 5 个):');
  artifacts.slice(0, 5).forEach((a) => {
    console.log(`  ${a.id} (name: ${a.name})`);
  });
} catch (err) {
  console.log('\n无法读取 store.json:', err.message);
}
