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
