import { AppError } from '../core/app-error.js';

export const Roles = Object.freeze({
  PLATFORM_ADMIN: 'platform_admin',
  MERCHANT_ADMIN: 'merchant_admin',
  OPERATOR: 'operator',
});

export function assertRole(user, allowedRoles) {
  if (!user || !allowedRoles.includes(user.role)) {
    throw new AppError('FORBIDDEN', 'You do not have permission to perform this action', 403);
  }
}

export function assertMerchantAccess(user, merchantId) {
  if (user.role === Roles.PLATFORM_ADMIN) {
    return;
  }
  if (!user.merchantId || user.merchantId !== merchantId) {
    throw new AppError('FORBIDDEN', 'Cross-merchant access is not allowed', 403);
  }
}

export function findMerchantOrThrow(state, merchantId, options = {}) {
  const merchant = state.merchants.find((item) => item.id === merchantId);
  if (!merchant) {
    throw new AppError('MERCHANT_NOT_FOUND', 'Merchant was not found', 404);
  }
  if (options.requireActive && merchant.status !== 'active') {
    throw new AppError('MERCHANT_DISABLED', 'Merchant is disabled', 403);
  }
  return merchant;
}

export function findApplicationOrThrow(state, appId, options = {}) {
  const application = state.applications.find((item) => item.id === appId);
  if (!application) {
    throw new AppError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
  }
  if (options.requireActive && application.status !== 'active') {
    throw new AppError('APPLICATION_DISABLED', 'Application is disabled', 403);
  }
  return application;
}

export function findLicenseOrThrow(state, licenseId) {
  const license = state.licenses.find((item) => item.id === licenseId);
  if (!license) {
    throw new AppError('LICENSE_NOT_FOUND', 'License was not found', 404);
  }
  return license;
}

export function findBindingOrThrow(state, bindingId) {
  const binding = state.deviceBindings.find((item) => item.id === bindingId);
  if (!binding) {
    throw new AppError('DEVICE_BINDING_NOT_FOUND', 'Device binding was not found', 404);
  }
  return binding;
}
