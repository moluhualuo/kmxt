import { AppError } from '../core/app-error.js';
import { optionalInteger, optionalString, requireString } from '../core/validation.js';

// 作者: 花落 (MIT License)
// WS4 防重打包 / APK 签名绑定：服务端强制校验客户端的 packageName / 签名证书 SHA-256 /
// versionCode 与应用注册的绑定一致。native 客户端已用 package 名选信任根，此处是与之
// 呼应的服务端强制点，杜绝"改包名 / 二次签名 / 旧版本降级"绕过。
//
// 设计原则（fail-closed 但向后兼容）：
//   - 应用未注册任何绑定约束（历史应用）→ 跳过校验，保持兼容；
//   - 应用注册了绑定约束 → 客户端必须提交且匹配，缺失即 INTEGRITY_REJECTED。

const PACKAGE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const MAX_VERSION_CODE = 2_100_000_000; // Android versionCode 上限量级

/**
 * 从请求 body 解析客户端完整性字段。全部可选——是否强制由应用注册状态决定。
 * @returns {{ packageName: string|null, certSha256: string|null, versionCode: number|null }}
 */
export function parseClientIntegrityInput(input = {}) {
  const packageName = optionalString(input.packageName, 'packageName', {
    min: 3,
    max: 255,
    normalize: false,
    pattern: PACKAGE_NAME_PATTERN,
  });
  const rawCert = optionalString(input.certSha256, 'certSha256', {
    min: 64,
    max: 64,
    normalize: false,
  });
  const certSha256 = rawCert === null ? null : rawCert.toLowerCase();
  if (certSha256 !== null && !HEX_SHA256.test(certSha256)) {
    throw new AppError('INVALID_INPUT', 'certSha256 must be a hex SHA-256 digest', 400);
  }
  const versionCode = optionalInteger(input.versionCode, 'versionCode', {
    min: 1,
    max: MAX_VERSION_CODE,
  });
  return { packageName, certSha256, versionCode };
}

/**
 * 应用是否注册了任一绑定约束。任一存在即视为"要求客户端完整性校验"。
 */
export function applicationRequiresIntegrity(application) {
  return Boolean(
    application
      && (application.androidPackage
        || (Array.isArray(application.signingCertificates) && application.signingCertificates.length > 0)
        || Number.isSafeInteger(application.minVersionCode)),
  );
}

/**
 * 强制校验客户端完整性字段与应用注册绑定一致。fail-closed。
 * @param {object} application 已从 store 取到的应用对象（含注册的绑定约束）
 * @param {{packageName:string|null,certSha256:string|null,versionCode:number|null}} client
 */
export function assertClientIntegrity(application, client) {
  if (!applicationRequiresIntegrity(application)) {
    return; // 历史应用未注册绑定：跳过，向后兼容。
  }
  const { packageName, certSha256, versionCode } = client || {};

  // 包名绑定。
  if (application.androidPackage) {
    if (!packageName) {
      throw new AppError('INTEGRITY_REJECTED', 'Client did not provide a package name', 403);
    }
    if (packageName !== application.androidPackage) {
      throw new AppError('SIGNATURE_MISMATCH', 'Client package name does not match the registered binding', 403);
    }
  }

  // 签名证书绑定（应用可登记多个允许的证书指纹，支持轮换）。
  if (Array.isArray(application.signingCertificates) && application.signingCertificates.length > 0) {
    if (!certSha256) {
      throw new AppError('INTEGRITY_REJECTED', 'Client did not provide a signing certificate digest', 403);
    }
    const allowed = application.signingCertificates.map((item) => String(item).toLowerCase());
    if (!allowed.includes(certSha256)) {
      throw new AppError('SIGNATURE_MISMATCH', 'Client signing certificate does not match the registered binding', 403);
    }
  }

  // 最低版本绑定（降级防护）。
  if (Number.isSafeInteger(application.minVersionCode)) {
    if (versionCode === null || versionCode === undefined) {
      throw new AppError('INTEGRITY_REJECTED', 'Client did not provide a version code', 403);
    }
    if (versionCode < application.minVersionCode) {
      throw new AppError('CLIENT_UPDATE_REQUIRED', 'Client version is older than the minimum required version', 426);
    }
  }
}

/**
 * 注册 / 更新应用时校验并规范化绑定约束字段。
 * 返回可直接并入 application 对象的字段（未提供的返回 undefined，调用方决定是否覆盖）。
 */
export function normalizeApplicationBinding(input = {}) {
  const result = {};
  if (input.androidPackage !== undefined) {
    result.androidPackage = input.androidPackage === null
      ? null
      : requireString(input.androidPackage, 'androidPackage', {
        min: 3,
        max: 255,
        normalize: false,
        pattern: PACKAGE_NAME_PATTERN,
      });
  }
  if (input.signingCertificates !== undefined) {
    if (input.signingCertificates === null) {
      result.signingCertificates = null;
    } else {
      if (!Array.isArray(input.signingCertificates)) {
        throw new AppError('INVALID_INPUT', 'signingCertificates must be an array', 400);
      }
      if (input.signingCertificates.length > 8) {
        throw new AppError('INVALID_INPUT', 'signingCertificates supports at most 8 entries', 400);
      }
      result.signingCertificates = input.signingCertificates.map((item, index) => {
        const value = requireString(item, `signingCertificates[${index}]`, {
          min: 64,
          max: 64,
          normalize: false,
        }).toLowerCase();
        if (!HEX_SHA256.test(value)) {
          throw new AppError('INVALID_INPUT', `signingCertificates[${index}] must be a hex SHA-256 digest`, 400);
        }
        return value;
      });
    }
  }
  if (input.minVersionCode !== undefined) {
    result.minVersionCode = input.minVersionCode === null
      ? null
      : optionalInteger(input.minVersionCode, 'minVersionCode', { min: 1, max: MAX_VERSION_CODE });
  }
  return result;
}

// 花落 / MIT：公告与更新提示的纯文本约束。这些文字最终进入签名载荷并下发到全部客户端，
// 任何富文本或链接能力都会成为攻击者的推送通道，因此在入口直接拒收而不是转义后接受。
// 标题类字段强制单行；正文类字段允许换行分段，但限制行数，避免用超长空行把客户端
// 公告卡片顶出屏幕。回车符一律不接受，换行统一用 LF 表示，保证签名载荷逐字节可复现。
const MARKUP_REJECT_PATTERN = /[<>]|javascript:|data:|vbscript:/i;
const SINGLE_LINE_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
// 允许 LF(\u000a) 分段，仍拒绝 CR 与其余控制字符。
const MULTILINE_CONTROL_PATTERN = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const MAX_TEXT_LINES = 20;

export function assertPlainText(value, field, { multiline = false } = {}) {
  const controlPattern = multiline ? MULTILINE_CONTROL_PATTERN : SINGLE_LINE_CONTROL_PATTERN;
  if (MARKUP_REJECT_PATTERN.test(value) || controlPattern.test(value)) {
    throw new AppError(
      'INVALID_INPUT',
      multiline
        ? `${field} must be plain text without markup, scheme prefixes or control characters other than line breaks`
        : `${field} must be plain text on a single line without markup or scheme prefixes`,
      400,
    );
  }
  if (multiline && value.split('\n').length > MAX_TEXT_LINES) {
    throw new AppError('INVALID_INPUT', `${field} must not exceed ${MAX_TEXT_LINES} lines`, 400);
  }
  return value;
}

/**
 * 注册 / 更新应用时校验并规范化“当前最新版本”发布策略。
 * `minVersionCode` 决定硬拒绝（见 assertClientIntegrity），此处只描述最新版本，
 * 供客户端显示“该升到哪个版本”。返回值只包含显式提供的键，调用方决定是否覆盖。
 *
 * 注意：不接受下载地址。下发 URL 等于开一条“服务端说去哪下载就去哪下载”的通道，
 * 官方渠道必须编译进客户端，协议层不留跳转注入面。
 */
export function normalizeClientRelease(input = {}) {
  const result = {};
  if (input.latestVersionCode !== undefined) {
    result.latestVersionCode = input.latestVersionCode === null
      ? null
      : optionalInteger(input.latestVersionCode, 'latestVersionCode', { min: 1, max: MAX_VERSION_CODE });
  }
  if (input.latestVersionName !== undefined) {
    result.latestVersionName = input.latestVersionName === null
      ? null
      : assertPlainText(
        requireString(input.latestVersionName, 'latestVersionName', { min: 1, max: 64 }),
        'latestVersionName',
      );
  }
  if (input.releaseNotes !== undefined) {
    result.releaseNotes = input.releaseNotes === null || input.releaseNotes === ''
      ? null
      : assertPlainText(
        requireString(input.releaseNotes, 'releaseNotes', { min: 1, max: 2000 }),
        'releaseNotes',
        { multiline: true },
      );
  }
  return result;
}

/**
 * 校验最低版本不高于最新版本。两者都由管理员分别设置，一旦
 * minVersionCode > latestVersionCode，连最新版客户端都会被 426 拒绝，
 * 全部用户直接锁死且无版本可升——这是自锁陷阱，必须在写入前拦住。
 * 调用方传入合并后的最终值（已有值 + 本次修改）。
 */
export function assertVersionPolicyConsistent(minVersionCode, latestVersionCode) {
  if (!Number.isSafeInteger(minVersionCode) || !Number.isSafeInteger(latestVersionCode)) {
    return;
  }
  if (minVersionCode > latestVersionCode) {
    throw new AppError(
      'INVALID_INPUT',
      'minVersionCode must not be greater than latestVersionCode; otherwise every client is locked out with no upgrade target',
      400,
    );
  }
}
