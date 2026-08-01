import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { AnnouncementService, MAX_SIGNED_ANNOUNCEMENTS } from '../src/services/announcement-service.js';
import { createStore } from '../src/storage/create-store.js';
import {
  encryptText,
  generateSigningKeyPair,
  loadOrCreateRootSecret,
  verifySignedEnvelope,
} from '../src/security/crypto.js';
import { AppError } from '../src/core/app-error.js';

/**
 * 公告管理与签名下发测试。验证 CRUD 权限、时间窗过滤、序号单调性、防回滚签名载荷。
 * 作者：花落｜MIT License。
 */
describe('AnnouncementService', () => {
  const workDirs = [];
  let workDir;
  let store;
  let rootSecret;
  let service;
  let appId;
  let platformAdmin;
  let merchantAdmin;
  let operator;
  let merchant;
  let application;

  after(async () => {
    // 花落 / MIT：集中清理所有用例的临时目录。清理注册在套件级，避免在 beforeEach 里注册
    // 导致 JsonStore 还在异步落盘时目录已被删除（ENOENT）。
    await Promise.all(workDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  beforeEach(async () => {
    // 花落 / MIT：JsonStore 需要真实路径，rootSecret 需要真实秘钥文件；用临时目录隔离每个用例。
    workDir = await mkdtemp(path.join(tmpdir(), 'kmxt-ann-'));
    workDirs.push(workDir);
    store = await createStore({ storageDriver: 'json', dataFile: path.join(workDir, 'store.json') });
    rootSecret = await loadOrCreateRootSecret(path.join(workDir, 'secret.key'));
    service = new AnnouncementService(store, rootSecret, { protocolVersion: 1 });

    // publicNotice 要求 appId 为 36 位 UUID，故程序 id 使用真实 UUID。
    appId = randomUUID();
    // 真实 Ed25519 密钥对，私钥按 `app-signing:${appId}` 加密，供 publicNotice 解密验签。
    const keyPair = generateSigningKeyPair();
    const encryptedPrivateKey = encryptText(rootSecret, `app-signing:${appId}`, keyPair.privateKey);

    await store.transaction((state) => {
      merchant = {
        id: 'm1',
        code: 'TEST',
        name: '测试商户',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      state.merchants.push(merchant);

      application = {
        id: appId,
        merchantId: 'm1',
        code: 'DEMO',
        name: '演示程序',
        description: '',
        status: 'active',
        settings: { defaultDurationDays: 30, defaultMaxDevices: 1, heartbeatSeconds: 300, offlineGraceSeconds: 900 },
        signingKeyId: 'key1',
        signingPublicKey: keyPair.publicKey,
        signingPrivateKeyEncrypted: encryptedPrivateKey,
        announcementSequence: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      state.applications.push(application);

      platformAdmin = {
        id: 'u1',
        merchantId: 'm1',
        username: 'admin',
        displayName: '平台管理员',
        passwordHash: '',
        role: 'platform_admin',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      merchantAdmin = {
        id: 'u2',
        merchantId: 'm1',
        username: 'merchant_admin',
        displayName: '商户管理员',
        passwordHash: '',
        role: 'merchant_admin',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      operator = {
        id: 'u3',
        merchantId: 'm1',
        username: 'operator',
        displayName: '操作员',
        passwordHash: '',
        role: 'operator',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      state.users.push(platformAdmin, merchantAdmin, operator);
    });
  });
  test('operator 可以列出公告，但不能创建', async () => {
    const list = await service.list(operator, appId);
    assert.equal(list.length, 0);

    await assert.rejects(
      () => service.create(operator, appId, { title: '测试', body: '内容', severity: 'info' }),
      (err) => err instanceof AppError && err.code === 'FORBIDDEN',
    );
  });

  test('merchant_admin 创建公告时序号单调递增，删除公告不影响后续序号', async () => {
    const first = await service.create(merchantAdmin, appId, {
      title: '第一条公告',
      body: '这是第一条公告的正文。',
      severity: 'info',
    });
    assert.equal(first.sequence, 1);
    assert.equal(first.status, 'draft');

    const second = await service.create(merchantAdmin, appId, {
      title: '第二条公告',
      body: '这是第二条公告的正文。',
      severity: 'warning',
    });
    assert.equal(second.sequence, 2);

    // 删除第二条
    await service.delete(merchantAdmin, second.id);

    // 再创建一条，序号应该是 3 而不是 2（防止客户端防回滚误杀）
    const third = await service.create(merchantAdmin, appId, {
      title: '第三条公告',
      body: '这是第三条公告的正文。',
      severity: 'critical',
    });
    assert.equal(third.sequence, 3);
  });

  test('setStatus 将草稿发布后记录 publishedAt 时间戳', async () => {
    const announcement = await service.create(merchantAdmin, appId, {
      title: '待发布公告',
      body: '正文',
      severity: 'info',
    });
    assert.equal(announcement.publishedAt, null);

    const published = await service.setStatus(merchantAdmin, announcement.id, 'published');
    assert.equal(published.status, 'published');
    assert.ok(published.publishedAt);
    assert.ok(Date.parse(published.publishedAt) > 0);
  });

  test('update 修改标题、正文、严重性、时间窗，校验 startsAt < endsAt', async () => {
    const announcement = await service.create(merchantAdmin, appId, {
      title: '原标题',
      body: '原正文',
      severity: 'info',
      startsAt: '2026-07-30T00:00:00.000Z',
      endsAt: '2026-08-01T00:00:00.000Z',
    });

    const updated = await service.update(merchantAdmin, announcement.id, {
      title: '新标题',
      severity: 'warning',
      endsAt: '2026-08-05T00:00:00.000Z',
    });
    assert.equal(updated.title, '新标题');
    assert.equal(updated.body, '原正文');
    assert.equal(updated.severity, 'warning');
    assert.equal(updated.endsAt, '2026-08-05T00:00:00.000Z');

    // 尝试让结束时间早于开始时间
    await assert.rejects(
      () => service.update(merchantAdmin, announcement.id, { endsAt: '2026-07-29T00:00:00.000Z' }),
      (err) => err instanceof AppError && err.code === 'INVALID_INPUT',
    );
  });
  test('selectPublishable 只返回已发布且在时间窗内的公告，按序号倒序取前 3 条', async () => {
    const now = Date.parse('2026-07-30T12:00:00.000Z');

    const a1 = await service.create(merchantAdmin, appId, {
      title: '过去公告（已结束）',
      body: '正文',
      severity: 'info',
      startsAt: '2026-07-20T00:00:00.000Z',
      endsAt: '2026-07-25T00:00:00.000Z',
    });
    await service.setStatus(merchantAdmin, a1.id, 'published');

    const a2 = await service.create(merchantAdmin, appId, {
      title: '当前公告1',
      body: '正文',
      severity: 'info',
      startsAt: '2026-07-28T00:00:00.000Z',
      endsAt: null,
    });
    await service.setStatus(merchantAdmin, a2.id, 'published');

    const a3 = await service.create(merchantAdmin, appId, {
      title: '当前公告2',
      body: '正文',
      severity: 'warning',
      startsAt: null,
      endsAt: '2026-08-05T00:00:00.000Z',
    });
    await service.setStatus(merchantAdmin, a3.id, 'published');

    const a4 = await service.create(merchantAdmin, appId, {
      title: '未来公告（未开始）',
      body: '正文',
      severity: 'critical',
      startsAt: '2026-08-10T00:00:00.000Z',
      endsAt: null,
    });
    await service.setStatus(merchantAdmin, a4.id, 'published');

    const a5 = await service.create(merchantAdmin, appId, {
      title: '当前公告3',
      body: '正文',
      severity: 'info',
    });
    await service.setStatus(merchantAdmin, a5.id, 'published');

    await service.create(merchantAdmin, appId, {
      title: '当前公告4（草稿）',
      body: '正文',
      severity: 'info',
    });
    // 不发布

    const publishable = await store.read((state) =>
      AnnouncementService.selectPublishable(state, appId, now),
    );

    // 应该返回 a5, a3, a2（序号 6, 4, 3），过滤掉 a1（已结束）、a4（未开始）、草稿
    assert.equal(publishable.length, 3);
    assert.equal(publishable[0].id, a5.id);
    assert.equal(publishable[1].id, a3.id);
    assert.equal(publishable[2].id, a2.id);
  });

  test('selectPublishable 在公告超过 3 条时只返回序号最大的 3 条', async () => {
    const now = Date.now();

    for (let i = 1; i <= 5; i++) {
      const announcement = await service.create(merchantAdmin, appId, {
        title: `公告 ${i}`,
        body: '正文',
        severity: 'info',
      });
      await service.setStatus(merchantAdmin, announcement.id, 'published');
    }

    const publishable = await store.read((state) =>
      AnnouncementService.selectPublishable(state, appId, now),
    );

    assert.equal(publishable.length, MAX_SIGNED_ANNOUNCEMENTS);
    assert.equal(publishable[0].sequence, 5);
    assert.equal(publishable[1].sequence, 4);
    assert.equal(publishable[2].sequence, 3);
  });

  test('publicNotice 返回程序签名信封，载荷包含 clientPolicy 与 announcements，sequence 取程序单调计数器', async () => {
    await store.transaction((state) => {
      const app = state.applications.find((item) => item.id === appId);
      app.minVersionCode = 100;
      app.latestVersionCode = 120;
      app.latestVersionName = '1.2.0';
      app.releaseNotes = '修复已知问题。';
    });

    const a1 = await service.create(merchantAdmin, appId, {
      title: '公告1',
      body: '正文1',
      severity: 'info',
    });
    await service.setStatus(merchantAdmin, a1.id, 'published');

    const a2 = await service.create(merchantAdmin, appId, {
      title: '公告2',
      body: '正文2',
      severity: 'warning',
    });
    await service.setStatus(merchantAdmin, a2.id, 'published');

    const now = Date.now();
    const envelope = await service.publicNotice(appId, now);

    assert.ok(envelope.payload);
    assert.ok(envelope.signature);
    assert.equal(envelope.keyId, 'key1');

    // createSignedEnvelope 的 payload 是对象而非 JSON 字符串。
    const payload = envelope.payload;
    assert.equal(payload.type, 'client_notice');
    assert.equal(payload.protocolVersion, 1);
    assert.equal(payload.appId, appId);
    assert.equal(payload.sequence, 2);
    assert.ok(payload.issuedAt);
    assert.deepEqual(payload.clientPolicy, {
      minVersionCode: 100,
      latestVersionCode: 120,
      latestVersionName: '1.2.0',
      releaseNotes: '修复已知问题。',
    });
    assert.equal(payload.announcements.length, 2);
    assert.equal(payload.announcements[0].sequence, 2);
    assert.equal(payload.announcements[1].sequence, 1);
  });

  test('publicNotice 在没有可下发公告时 sequence 为 0', async () => {
    const now = Date.now();
    const envelope = await service.publicNotice(appId, now);
    const payload = envelope.payload;

    assert.equal(payload.sequence, 0);
    assert.equal(payload.announcements.length, 0);
  });

  /**
   * 花落 / MIT：下发集合会缩小（撤回、过期、删除、改成 placement=app），
   * 但 sequence 绝不能跟着回落——客户端 native 判定 `sequence < 持久化水位`
   * 为 NOTICE_ROLLBACK 并整封拒收，会把公告与版本策略一起永久打死。
   */
  test('publicNotice 的 sequence 在公告被撤回或删除后不回落', async () => {
    const a1 = await service.create(merchantAdmin, appId, {
      title: '公告1',
      body: '正文1',
      severity: 'info',
    });
    await service.setStatus(merchantAdmin, a1.id, 'published');
    const a2 = await service.create(merchantAdmin, appId, {
      title: '公告2',
      body: '正文2',
      severity: 'info',
    });
    await service.setStatus(merchantAdmin, a2.id, 'published');

    const before = await service.publicNotice(appId);
    assert.equal(before.payload.sequence, 2);
    assert.equal(before.payload.announcements.length, 2);

    // 撤回最新一条：下发集合缩小到 1 条，但水位必须保持 2。
    await service.setStatus(merchantAdmin, a2.id, 'draft');
    const afterUnpublish = await service.publicNotice(appId);
    assert.equal(afterUnpublish.payload.announcements.length, 1);
    assert.equal(afterUnpublish.payload.sequence, 2);

    // 删除全部公告：集合为空，水位仍保持 2。
    await service.delete(merchantAdmin, a1.id);
    await service.delete(merchantAdmin, a2.id);
    const afterDelete = await service.publicNotice(appId);
    assert.equal(afterDelete.payload.announcements.length, 0);
    assert.equal(afterDelete.payload.sequence, 2);
  });

  test('publicNotice 在 rootSecret/config 缺失时抛出 503', async () => {
    const serviceWithoutCrypto = new AnnouncementService(store);

    await assert.rejects(
      () => serviceWithoutCrypto.publicNotice(appId),
      (err) => err instanceof AppError && err.code === 'NOTICE_UNAVAILABLE' && err.status === 503,
    );
  });

  test('publicNotice 签名可用程序公钥验证，载荷规范化后字节级可复现', async () => {
    const a1 = await service.create(merchantAdmin, appId, {
      title: '验签测试公告',
      body: '客户端 native 会用 Ed25519 验签拒绝篡改载荷。',
      severity: 'info',
    });
    await service.setStatus(merchantAdmin, a1.id, 'published');

    const envelope = await service.publicNotice(appId);

    // 花落 / MIT：用程序公钥验证签名，模拟客户端 native 验签路径。
    const publicKey = await store.read((state) =>
      state.applications.find((item) => item.id === appId).signingPublicKey,
    );
    assert.ok(verifySignedEnvelope(envelope, publicKey), 'signature must verify against public key');
  });

  /**
   * placement 三层过滤：与 status、时间窗相互独立，决定公告进入哪条下发通道。
   * gate = 通道 B（卡密验证页），app = 通道 A（激活后的软件内），both = 两条都进。
   */
  describe('placement 投放位置', () => {
    async function publish(fields) {
      const announcement = await service.create(merchantAdmin, appId, {
        body: '正文',
        severity: 'info',
        ...fields,
      });
      await service.setStatus(merchantAdmin, announcement.id, 'published');
      return announcement;
    }

    test('缺省 placement 为 both，历史公告（无该键）读取时也归一为 both', async () => {
      const created = await service.create(merchantAdmin, appId, {
        title: '缺省公告',
        body: '正文',
        severity: 'info',
      });
      assert.equal(created.placement, 'both');

      // 模拟升级前写入的历史记录：payload 里根本没有 placement 键。
      await store.transaction((state) => {
        delete state.announcements.find((item) => item.id === created.id).placement;
      });
      const [listed] = await service.list(merchantAdmin, appId);
      assert.equal(listed.placement, 'both');

      await service.setStatus(merchantAdmin, created.id, 'published');
      const gate = await service.listPublishable(appId, Date.now(), 'gate');
      const app = await service.listPublishable(appId, Date.now(), 'app');
      assert.equal(gate.length, 1);
      assert.equal(app.length, 1);
    });

    test('placement=gate 只进验证页通道，placement=app 只进软件内通道，both 两条都进', async () => {
      const gateOnly = await publish({ title: '仅验证页', placement: 'gate' });
      const appOnly = await publish({ title: '仅软件内', placement: 'app' });
      const both = await publish({ title: '全部页面', placement: 'both' });

      const now = Date.now();
      const gateIds = (await service.listPublishable(appId, now, 'gate')).map((item) => item.id);
      const appIds = (await service.listPublishable(appId, now, 'app')).map((item) => item.id);

      assert.deepEqual(gateIds.sort(), [both.id, gateOnly.id].sort());
      assert.deepEqual(appIds.sort(), [appOnly.id, both.id].sort());

      // channel = null 保持旧语义：不按 placement 过滤。
      const all = await service.listPublishable(appId, now);
      assert.equal(all.length, 3);
    });

    test('placement 过滤先于条数上限，一条通道不会被另一条通道的公告挤空', async () => {
      for (let i = 1; i <= MAX_SIGNED_ANNOUNCEMENTS; i++) {
        await publish({ title: `验证页公告 ${i}`, placement: 'gate' });
      }
      const appOnly = await publish({ title: '软件内公告', placement: 'app' });

      const appList = await service.listPublishable(appId, Date.now(), 'app');
      assert.equal(appList.length, 1);
      assert.equal(appList[0].id, appOnly.id);

      const gateList = await service.listPublishable(appId, Date.now(), 'gate');
      assert.equal(gateList.length, MAX_SIGNED_ANNOUNCEMENTS);
    });

    test('publicNotice 只下发命中 gate 的公告', async () => {
      const gateOnly = await publish({ title: '仅验证页', placement: 'gate' });
      await publish({ title: '仅软件内', placement: 'app' });

      const envelope = await service.publicNotice(appId);
      const ids = envelope.payload.announcements.map((item) => item.id);
      assert.deepEqual(ids, [gateOnly.id]);
    });

    test('下发载荷不包含 placement 字段（客户端不需要，旧 native 形状校验也不认识）', async () => {
      await publish({ title: '仅验证页', placement: 'gate' });

      const [signed] = await service.listPublishable(appId, Date.now(), 'gate');
      assert.deepEqual(
        Object.keys(signed).sort(),
        ['body', 'id', 'publishedAt', 'sequence', 'severity', 'title'],
      );
    });

    test('update 可以改 placement，未传该字段时保持原值', async () => {
      const created = await service.create(merchantAdmin, appId, {
        title: '待改投放',
        body: '正文',
        severity: 'info',
        placement: 'gate',
      });

      const renamed = await service.update(merchantAdmin, created.id, { title: '改了标题' });
      assert.equal(renamed.placement, 'gate');

      const moved = await service.update(merchantAdmin, created.id, { placement: 'app' });
      assert.equal(moved.placement, 'app');

      const back = await service.update(merchantAdmin, created.id, { placement: 'both' });
      assert.equal(back.placement, 'both');
    });

    test('非法 placement 取值被拒绝', async () => {
      await assert.rejects(
        () => service.create(merchantAdmin, appId, {
          title: '非法投放',
          body: '正文',
          severity: 'info',
          placement: 'gate-only',
        }),
        (err) => err instanceof AppError && err.code === 'INVALID_INPUT',
      );
    });

    test('selectPublishable 的 channel 参数只接受 gate / app', async () => {
      await assert.rejects(
        () => service.listPublishable(appId, Date.now(), 'both'),
        (err) => err instanceof AppError && err.code === 'INVALID_INPUT',
      );
    });
  });
});
