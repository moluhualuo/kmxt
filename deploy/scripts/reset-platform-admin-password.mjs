// 作者：花落；本运维重置脚本按 MIT License 使用。
import { readFile } from 'node:fs/promises';

const newPassword = process.env.KMXT_NEW_PASSWORD || '';
if (newPassword.length < 10 || newPassword.length > 128) {
  throw new Error('KMXT_NEW_PASSWORD must be between 10 and 128 characters');
}

const currentPassword = (await readFile('/run/secrets/kmxt_admin_password', 'utf8')).trim();

async function post(path, body, token = '') {
  const response = await fetch(`http://127.0.0.1:8080${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(`Request ${path} failed: ${payload.error?.code || response.status}`);
  }
  return payload.data;
}

const login = await post('/api/v1/auth/login', {
  username: 'platform-admin',
  password: currentPassword,
});
const changed = await post('/api/v1/auth/password', {
  currentPassword,
  newPassword,
}, login.token);
const verified = await post('/api/v1/auth/login', {
  username: 'platform-admin',
  password: newPassword,
});

console.log(JSON.stringify({
  passwordChanged: changed.passwordChanged === true,
  sessionsRevoked: changed.sessionsRevoked,
  verifiedRole: verified.user.role,
}));
