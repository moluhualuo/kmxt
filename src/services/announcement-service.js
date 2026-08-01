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

/**
 * 展示位置。决定一条公告进入哪条下发通道，与 status / 时间窗是相互独立的三层过滤。
 *
 * 花落 / MIT：两个取值直接对应客户端的两个页面，因为两条通道本来就只服务这两个场景——
 *   gate = 通道 B（GET /client/apps/:appId/notices，免鉴权）→ 卡密验证页；
 *   app  = 通道 A（activate / verify 的签名载荷）→ 激活后的软件内界面。
 * 默认 both：历史公告的 payload 里没有这个键，读取侧一律按 both 解释，
 * 升级服务端不会让任何已发布公告悄悄从某个页面消失。
 */
const PLACEMENTS = ['both', 'gate', 'app'];
const DEFAULT_PLACEMENT = 'both';
const PLACEMENT_CHANNELS = ['gate', 'app'];

// 对外沿用带前缀的名字，避免调用方 import 到过于泛化的 PLACEMENTS。
const ANNOUNCEMENT_PLACEMENTS = PLACEMENTS;
const DEFAULT_ANNOUNCEMENT_PLACEMENT = DEFAULT_PLACEMENT;

// 花落 / MIT：进入签名载荷的公告条数硬上限。载荷会挂在每一次 activate/verify 响应上，
// 不设上限会让心跳响应随公告数量线性膨胀，也给了攻击者放大响应体的机会。
const MAX_SIGNED_ANNOUNCEMENTS = 3;

/** 历史公告缺少 placement 键，读取侧统一归一为 both，避免 undefined 流入签名载荷。*/
function readPlacement(announcement) {
  return PLACEMENTS.includes(announcement.placement)
    ? announcement.placement
    : DEFAULT_PLACEMENT;
}

function matchesChannel(announcement, channel) {
  const placement = readPlacement(announcement);
  return placement === DEFAULT_PLACEMENT || placement === channel;
}

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
    placement: readPlacement(announcement),
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
 *
 * 花落 / MIT：placement 也刻意不下发。它是「服务端决定这条公告出现在哪个页面」的
 * 投放开关，过滤在服务端已经完成；把它塞进载荷只会让客户端多一个可以自行解释的
 * 字段，且旧客户端的 native 形状校验并不认识它。
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
  // 花落 / MIT：创建时缺省为 both（与历史行为一致：两个页面都展示）。
  // 部分更新时缺省为 undefined，才能区分「没有传这个字段」和「显式改回 both」。
  if (!partial || payload.placement !== undefined) {
    result.placement = requireEnum(
      payload.placement ?? DEFAULT_PLACEMENT,
      'placement',
      PLACEMENTS,
    );
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
        placement: fields.placement,
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
        metadata: {
          appId,
          severity: announcement.severity,
          placement: announcement.placement,
          sequence: nextSequence,
        },
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
   * 取该程序当前可下发的公告，供签名载荷使用。只返回 published、在时间窗内、
   * 且 placement 命中本通道的条目，按序号倒序取前 MAX_SIGNED_ANNOUNCEMENTS 条。
   * 该方法不做权限检查：调用方是已经通过卡密会话校验的客户端路径，或公开的只读公告端点。
   *
   * 花落 / MIT：条数上限在 placement 过滤「之后」才截取。若先截取再过滤，一批
   * gate 公告会把 app 通道的名额吃光，管理员会看到「明明发布了却在软件内看不到」。
   */
  static selectPublishable(state, appId, nowMilliseconds = Date.now(), channel = null) {
    if (channel !== null && !PLACEMENT_CHANNELS.includes(channel)) {
      throw new AppError('INVALID_INPUT', 'channel must be one of: gate, app', 400);
    }
    return state.announcements
      .filter((item) => {
        if (item.appId !== appId || item.status !== 'published') return false;
        if (channel !== null && !matchesChannel(item, channel)) return false;
        if (item.startsAt && Date.parse(item.startsAt) > nowMilliseconds) return false;
        if (item.endsAt && Date.parse(item.endsAt) <= nowMilliseconds) return false;
        return true;
      })
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, MAX_SIGNED_ANNOUNCEMENTS)
      .map(presentSignedAnnouncement);
  }

  async listPublishable(appId, nowMilliseconds = Date.now(), channel = null) {
    return this.store.read((state) => AnnouncementService.selectPublishable(
      state,
      appId,
      nowMilliseconds,
      channel,
    ));
  }

  /**
   * 通道 B：未激活用户的公开公告端点。无需卡密会话，但仍返回程序 Ed25519 签名信封。
   * 只下发 placement 命中 gate 的公告——这条通道唯一的消费者是卡密验证页。
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
        announcements: AnnouncementService.selectPublishable(
          state,
          id,
          nowMilliseconds,
          'gate',
        ),
      };
    });
    const { application } = snapshot;
    /*
     * 载荷内的 sequence 直接取程序上只增不减的 announcementSequence 计数器，供客户端
     * 做防回滚比较。
     *
     * 花落 / MIT：这里刻意不用「本次下发公告的最大序号」。客户端 native 的判定是
     * `sequence < 已持久化水位 → NOTICE_ROLLBACK`（整封拒收，连版本策略一起丢），
     * 而下发集合是会缩小的：撤回发布、公告过期、删除，以及本次新增的把 placement
     * 改成 app（不再在验证页展示）——任何一种都会让最大序号回落甚至变成 0，于是
     * 一次完全合法的管理操作会把所有老客户端的公告通道永久打死。计数器只随创建
     * 递增，既保留了「拒绝历史信封重放」的效果，又不会被内容变更拉低。
     * 计数器只增不减也保证从旧语义升级过来是单调的：它必然 ≥ 任何已发布公告的序号，
     * 也就 ≥ 客户端已存的水位，升级瞬间不会误判回滚。
     */
    const noticeSequence = Number.isSafeInteger(application.announcementSequence)
      && application.announcementSequence > 0
      ? application.announcementSequence
      : 0;
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
      sequence: noticeSequence,
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

export {
  ANNOUNCEMENT_PLACEMENTS,
  DEFAULT_ANNOUNCEMENT_PLACEMENT,
  MAX_SIGNED_ANNOUNCEMENTS,
  presentSignedAnnouncement,
};
