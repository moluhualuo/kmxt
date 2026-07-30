import { randomUUID } from 'node:crypto';
import { AppError } from '../core/app-error.js';
import {
  optionalString,
  requireEnum,
  requireObject,
  requireString,
} from '../core/validation.js';
import {
  assertMerchantAccess,
  assertRole,
  findApplicationOrThrow,
  findMerchantOrThrow,
  Roles,
} from './access-control.js';
import { createSignedEnvelope, decryptText } from '../security/crypto.js';
import { AuditService } from './audit-service.js';
import { assertPlainText } from './client-integrity.js';

const ADMIN_ROLES = [Roles.PLATFORM_ADMIN, Roles.MERCHANT_ADMIN, Roles.OPERATOR];
const OWNER_ROLES = [Roles.PLATFORM_ADMIN, Roles.MERCHANT_ADMIN];
const SEVERITIES = ['info', 'warning', 'critical'];
const STATUSES = ['draft', 'published'];

// 花落 / MIT：进入签名载荷的公告条数硬上限。载荷会挂在每一次 activate/verify 响应上，
// 不设上限会让心跳响应随公告数量线性膨胀，也给了攻击者放大响应体的机会。
const MAX_SIGNED_ANNOUNCEMENTS = 3;

function parseOptionalIsoDate(value, field) {
  const raw = optionalString(value, field, { min: 20, max: 40 });
  if (raw === null) return null;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    throw new AppError('INVALID_INPUT', `${field} must be a valid ISO-8601 date`, 400);
  }
  return new Date(timestamp).toISOString();
}

function assertWindowOrdered(startsAt, endsAt) {
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new AppError('INVALID_INPUT', 'endsAt must be later than startsAt', 400);
  }
}

/**
 * 管理端展示用的公告投影。不含内部 merchantId 之外的任何秘密，
 * 所有可选字段显式归一为 null，避免 undefined 流入签名载荷（见 canonicalJson）。
 */
function presentAnnouncement(announcement) {
  return {
    id: announcement.id,
    appId: announcement.appId,
    merchantId: announcement.merchantId,
    sequence: announcement.sequence,
    title: announcement.title,
    body: announcement.body,
    severity: announcement.severity,
    status: announcement.status,
    startsAt: announcement.startsAt ?? null,
    endsAt: announcement.endsAt ?? null,
    publishedAt: announcement.publishedAt ?? null,
    createdAt: announcement.createdAt,
    updatedAt: announcement.updatedAt,
  };
}

/**
 * 下发给客户端的公告投影。只保留展示必需字段，绝不包含 merchantId、
 * 内部状态或时间窗口等管理信息；这些字段会被程序私钥签名后下发到全部设备。
 */
function presentSignedAnnouncement(announcement) {
  return {
    id: announcement.id,
    sequence: announcement.sequence,
    severity: announcement.severity,
    title: announcement.title,
    body: announcement.body,
    publishedAt: announcement.publishedAt ?? null,
  };
}

function readAnnouncementInput(input, { partial = false } = {}) {
  const payload = requireObject(input);
  const result = {};

  if (!partial || payload.title !== undefined) {
    result.title = assertPlainText(
      requireString(payload.title, 'title', { min: 1, max: 100 }),
      'title',
    );
  }
  if (!partial || payload.body !== undefined) {
    result.body = assertPlainText(
      requireString(payload.body, 'body', { min: 1, max: 2000 }),
      'body',
      { multiline: true },
    );
  }
  if (!partial || payload.severity !== undefined) {
    result.severity = requireEnum(payload.severity ?? 'info', 'severity', SEVERITIES);
  }
  if (!partial || payload.startsAt !== undefined) {
    result.startsAt = parseOptionalIsoDate(payload.startsAt, 'startsAt');
  }
  if (!partial || payload.endsAt !== undefined) {
    result.endsAt = parseOptionalIsoDate(payload.endsAt, 'endsAt');
  }
  return result;
}

/**
 * 公告管理与签名下发。公告本身不参与任何授权决策，但它的内容会被程序私钥签名
 * 并下发到全部客户端，因此写入侧按纯文本失败关闭，读取侧按条数与状态严格过滤。
 * 作者：花落｜MIT。
 */
export class AnnouncementService {
  constructor(store, rootSecret = null, config = null) {
    this.store = store;
    // 花落 / MIT：根密钥与配置仅用于公开公告端点的程序私钥签名。缺省为 null 时
    // 管理侧 CRUD 完全可用，只有 publicNotice 不可用，便于测试单独构造本服务。
    this.rootSecret = rootSecret;
    this.config = config;
  }

  async list(actor, appId) {
    assertRole(actor, ADMIN_ROLES);
    return this.store.read((state) => {
      const application = findApplicationOrThrow(state, appId);
      assertMerchantAccess(actor, application.merchantId);
      return state.announcements
        .filter((item) => item.appId === appId)
        .sort((left, right) => right.sequence - left.sequence)
        .map(presentAnnouncement);
    });
  }

  async create(actor, appId, input) {
    assertRole(actor, OWNER_ROLES);
    const fields = readAnnouncementInput(input);
    assertWindowOrdered(fields.startsAt, fields.endsAt);
    const now = new Date().toISOString();
    const announcementId = randomUUID();

    return this.store.transaction((state) => {
      const application = findApplicationOrThrow(state, appId, { requireActive: true });
      assertMerchantAccess(actor, application.merchantId);
      findMerchantOrThrow(state, application.merchantId, { requireActive: true });

      // 花落 / MIT：序号取自 application 上单调递增的计数器，而不是现有公告的最大值。
      // 若从现有公告推导，删掉最新一条会让序号回退，客户端的防回滚检查就会把之后
      // 全部合法公告当成重放拒收。计数器只增不减，删除公告不影响后续序号。
      const nextSequence = Number.isSafeInteger(application.announcementSequence)
        ? application.announcementSequence + 1
        : 1;
      application.announcementSequence = nextSequence;
      application.updatedAt = now;

      const announcement = {
        id: announcementId,
        merchantId: application.merchantId,
        appId,
        sequence: nextSequence,
        title: fields.title,
        body: fields.body,
        severity: fields.severity,
        status: 'draft',
        startsAt: fields.startsAt,
        endsAt: fields.endsAt,
        publishedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      state.announcements.push(announcement);
      AuditService.append(state, {
        actor,
        merchantId: application.merchantId,
        action: 'announcement.create',
        resourceType: 'announcement',
        resourceId: announcementId,
        metadata: { appId, severity: announcement.severity, sequence: nextSequence },
      });
      return presentAnnouncement(announcement);
    });
  }

  async update(actor, announcementId, input) {
    assertRole(actor, OWNER_ROLES);
    const fields = readAnnouncementInput(input, { partial: true });

    return this.store.transaction((state) => {
      const announcement = this.#findOrThrow(state, announcementId);
      assertMerchantAccess(actor, announcement.merchantId);
      findMerchantOrThrow(state, announcement.merchantId, { requireActive: true });

      const nextStartsAt = fields.startsAt !== undefined ? fields.startsAt : announcement.startsAt;
      const nextEndsAt = fields.endsAt !== undefined ? fields.endsAt : announcement.endsAt;
      assertWindowOrdered(nextStartsAt, nextEndsAt);

      Object.assign(announcement, fields);
      announcement.updatedAt = new Date().toISOString();
      AuditService.append(state, {
        actor,
        merchantId: announcement.merchantId,
        action: 'announcement.update',
        resourceType: 'announcement',
        resourceId: announcement.id,
        metadata: { appId: announcement.appId, fields: Object.keys(fields) },
      });
      return presentAnnouncement(announcement);
    });
  }

  async setStatus(actor, announcementId, status) {
    assertRole(actor, OWNER_ROLES);
    const nextStatus = requireEnum(status, 'status', STATUSES);

    return this.store.transaction((state) => {
      const announcement = this.#findOrThrow(state, announcementId);
      assertMerchantAccess(actor, announcement.merchantId);
      findMerchantOrThrow(state, announcement.merchantId, { requireActive: true });

      const now = new Date().toISOString();
      announcement.status = nextStatus;
      announcement.updatedAt = now;
      if (nextStatus === 'published' && !announcement.publishedAt) {
        announcement.publishedAt = now;
      }
      AuditService.append(state, {
        actor,
        merchantId: announcement.merchantId,
        action: 'announcement.status.update',
        resourceType: 'announcement',
        resourceId: announcement.id,
        metadata: { appId: announcement.appId, status: nextStatus },
      });
      return presentAnnouncement(announcement);
    });
  }

  async delete(actor, announcementId) {
    assertRole(actor, OWNER_ROLES);

    return this.store.transaction((state) => {
      const announcement = this.#findOrThrow(state, announcementId);
      assertMerchantAccess(actor, announcement.merchantId);
      findMerchantOrThrow(state, announcement.merchantId, { requireActive: true });

      state.announcements = state.announcements.filter((item) => item.id !== announcement.id);
      AuditService.append(state, {
        actor,
        merchantId: announcement.merchantId,
        action: 'announcement.delete',
        resourceType: 'announcement',
        resourceId: announcement.id,
        metadata: { appId: announcement.appId, sequence: announcement.sequence },
      });
      return { announcementId: announcement.id, deleted: true };
    });
  }

  /**
   * 取该程序当前可下发的公告，供签名载荷使用。只返回 published 且在时间窗内的条目，
   * 按序号倒序取前 MAX_SIGNED_ANNOUNCEMENTS 条。该方法不做权限检查：调用方是已经
   * 通过卡密会话校验的客户端路径，或公开的只读公告端点。
   */
  static selectPublishable(state, appId, nowMilliseconds = Date.now()) {
    return state.announcements
      .filter((item) => {
        if (item.appId !== appId || item.status !== 'published') return false;
        if (item.startsAt && Date.parse(item.startsAt) > nowMilliseconds) return false;
        if (item.endsAt && Date.parse(item.endsAt) <= nowMilliseconds) return false;
        return true;
      })
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, MAX_SIGNED_ANNOUNCEMENTS)
      .map(presentSignedAnnouncement);
  }

  async listPublishable(appId, nowMilliseconds = Date.now()) {
    return this.store.read((state) => AnnouncementService.selectPublishable(
      state,
      appId,
      nowMilliseconds,
    ));
  }

  /**
   * 通道 B：未激活用户的公开公告端点。无需卡密会话，但仍返回程序 Ed25519 签名信封。
   *
   * 花落 / MIT：这是本次改动唯一新增的未认证下发通道，安全边界必须写清楚——
   *   1. 载荷只含公告与版本策略，绝不含设备、会话、卡密或商户内部信息；
   *   2. 不参与任何授权决策，客户端只用于展示，拿不到它也不影响验证；
   *   3. 没有请求 nonce，因此存在重放风险，用两层缓解：issuedAt 新鲜度由客户端
   *      按固定窗口校验，sequence 单调性由客户端持久化最大值拒绝回退。
   *      最坏情况退化为「看到一条真实但过期的公告」，可接受。
   */
  async publicNotice(appId, nowMilliseconds = Date.now()) {
    const id = requireString(appId, 'appId', { min: 36, max: 36 });
    if (!this.rootSecret || !this.config) {
      throw new AppError('NOTICE_UNAVAILABLE', 'Signed notices are not configured', 503);
    }
    const snapshot = await this.store.read((state) => {
      const application = findApplicationOrThrow(state, id, { requireActive: true });
      findMerchantOrThrow(state, application.merchantId, { requireActive: true });
      return {
        application,
        announcements: AnnouncementService.selectPublishable(state, id, nowMilliseconds),
      };
    });
    const { application } = snapshot;
    // 载荷内的 sequence 取本次下发公告的最大序号，供客户端做防回滚比较；
    // 没有可下发公告时为 0，客户端据此清空本地展示而不触发回滚拒绝。
    const highestSequence = snapshot.announcements
      .reduce((highest, item) => Math.max(highest, item.sequence), 0);
    const privateKey = decryptText(
      this.rootSecret,
      `app-signing:${application.id}`,
      application.signingPrivateKeyEncrypted,
    );
    return createSignedEnvelope({
      type: 'client_notice',
      protocolVersion: this.config.protocolVersion,
      appId: application.id,
      issuedAt: new Date(nowMilliseconds).toISOString(),
      sequence: highestSequence,
      clientPolicy: {
        minVersionCode: Number.isSafeInteger(application.minVersionCode)
          ? application.minVersionCode
          : null,
        latestVersionCode: Number.isSafeInteger(application.latestVersionCode)
          ? application.latestVersionCode
          : null,
        latestVersionName: application.latestVersionName ?? null,
        releaseNotes: application.releaseNotes ?? null,
      },
      announcements: snapshot.announcements,
    }, privateKey, application.signingKeyId);
  }

  #findOrThrow(state, announcementId) {
    const announcement = state.announcements.find((item) => item.id === announcementId);
    if (!announcement) {
      throw new AppError('ANNOUNCEMENT_NOT_FOUND', 'Announcement was not found', 404);
    }
    return announcement;
  }
}

export { MAX_SIGNED_ANNOUNCEMENTS, presentSignedAnnouncement };
