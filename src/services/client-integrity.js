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
