export function presentUser(user) {
  return {
    id: user.id,
    merchantId: user.merchantId,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

export function presentMerchant(merchant) {
  return {
    id: merchant.id,
    code: merchant.code,
    name: merchant.name,
    status: merchant.status,
    createdAt: merchant.createdAt,
    updatedAt: merchant.updatedAt,
  };
}

export function presentApplication(application) {
  return {
    id: application.id,
    merchantId: application.merchantId,
    code: application.code,
    name: application.name,
    description: application.description,
    status: application.status,
    settings: application.settings,
    signing: {
      algorithm: 'Ed25519',
      keyId: application.signingKeyId,
      publicKey: application.signingPublicKey,
    },
    // WS4 防重打包绑定约束（仅 owner 可见，用于登记允许的包名/证书/最低版本）。
    binding: {
      androidPackage: application.androidPackage ?? null,
      signingCertificates: application.signingCertificates ?? null,
      minVersionCode: application.minVersionCode ?? null,
    },
    // 花落 / MIT：当前最新版本策略，供后台表单回填与客户端更新提示。
    // 一律用 ?? null 归一：undefined 进入签名载荷会让 JSON.stringify 产出非法 JSON，
    // 客户端 native json::parse 会直接失败（见 canonicalJson 的 undefined 防护）。
    release: {
      latestVersionCode: application.latestVersionCode ?? null,
      latestVersionName: application.latestVersionName ?? null,
      releaseNotes: application.releaseNotes ?? null,
    },
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
  };
}

export function presentLicense(license) {
  return {
    id: license.id,
    merchantId: license.merchantId,
    appId: license.appId,
    batchId: license.batchId,
    keyPreview: license.keyPreview,
    status: license.status,
    durationDays: license.durationDays,
    fixedExpiresAt: license.fixedExpiresAt,
    activatedAt: license.activatedAt,
    expiresAt: license.expiresAt,
    maxDevices: license.maxDevices,
    createdAt: license.createdAt,
    updatedAt: license.updatedAt,
  };
}

export function presentDeviceBinding(binding) {
  return {
    id: binding.id,
    merchantId: binding.merchantId,
    appId: binding.appId,
    licenseId: binding.licenseId,
    deviceLabel: binding.deviceLabel,
    status: binding.status,
    boundAt: binding.boundAt,
    lastVerifiedAt: binding.lastVerifiedAt,
    revokedAt: binding.revokedAt,
  };
}

export function presentProduct(product) {
  return {
    id: product.id,
    merchantId: product.merchantId,
    appId: product.appId,
    name: product.name,
    description: product.description,
    priceCents: product.priceCents,
    currency: product.currency,
    durationDays: product.durationDays,
    maxDevices: product.maxDevices,
    sortOrder: product.sortOrder,
    status: product.status,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

export function presentOrder(order, options = {}) {
  return {
    id: order.id,
    orderNo: order.orderNo,
    merchantId: order.merchantId,
    appId: order.appId,
    productId: order.productId,
    product: order.productSnapshot,
    customerName: order.customerName,
    contact: options.contact ?? order.contactMasked,
    note: order.note,
    status: order.status,
    licenseId: order.licenseId,
    licenseKey: options.licenseKey ?? null,
    rejectReason: order.rejectReason,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    fulfilledAt: order.fulfilledAt,
    rejectedAt: order.rejectedAt,
  };
}
