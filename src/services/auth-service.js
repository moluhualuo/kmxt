import { randomUUID } from 'node:crypto';
import { AppError } from '../core/app-error.js';
import { requireEnum, requireString } from '../core/validation.js';
import {
  createOpaqueToken,
  digestSecret,
  hashPassword,
  verifyPassword,
} from '../security/crypto.js';
import {
  assertMerchantAccess,
  assertRole,
  findMerchantOrThrow,
  Roles,
} from './access-control.js';
import { AuditService } from './audit-service.js';
import { presentUser } from './presenters.js';

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

function validatePassword(value, field = 'password') {
  return requireString(value, field, { min: 10, max: 128, normalize: false });
}

function validateCredentials(input) {
  return {
    username: requireString(input.username, 'username', {
      min: 3,
      max: 64,
      pattern: USERNAME_PATTERN,
    }),
    password: validatePassword(input.password),
  };
}

export class AuthService {
  constructor(store, rootSecret, config) {
    this.store = store;
    this.rootSecret = rootSecret;
    this.config = config;
  }

  async bootstrapPlatformAdmin(input) {
    const credentials = validateCredentials(input);
    const displayName = requireString(input.displayName || credentials.username, 'displayName', {
      min: 1,
      max: 80,
    });
    const passwordHash = await hashPassword(credentials.password);

    return this.store.transaction((state) => {
      if (state.users.some((user) => user.role === Roles.PLATFORM_ADMIN)) {
        throw new AppError('PLATFORM_ADMIN_EXISTS', 'A platform administrator already exists', 409);
      }
      const now = new Date().toISOString();
      const user = {
        id: randomUUID(),
        merchantId: null,
        username: credentials.username,
        usernameNormalized: credentials.username.toLowerCase(),
        displayName,
        passwordHash,
        role: Roles.PLATFORM_ADMIN,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      };
      state.users.push(user);
      AuditService.append(state, {
        actor: user,
        action: 'platform_admin.bootstrap',
        resourceType: 'user',
        resourceId: user.id,
      });
      return presentUser(user);
    });
  }

  async login(input) {
    const credentials = validateCredentials(input);
    const snapshot = await this.store.read((state) => state.users.find(
      (user) => user.usernameNormalized === credentials.username.toLowerCase(),
    ) ?? null);

    let passwordValid = false;
    if (snapshot) {
      passwordValid = await verifyPassword(credentials.password, snapshot.passwordHash);
    } else {
      await hashPassword(credentials.password);
    }

    if (!snapshot || !passwordValid || snapshot.status !== 'active') {
      throw new AppError('INVALID_CREDENTIALS', 'Username or password is incorrect', 401);
    }

    const token = createOpaqueToken();
    const tokenDigest = digestSecret(this.rootSecret, 'admin-session', token);
    const expiresAt = new Date(Date.now() + this.config.adminSessionTtlSeconds * 1000).toISOString();
    const user = await this.store.transaction((state) => {
      const currentUser = state.users.find((item) => item.id === snapshot.id);
      if (!currentUser || currentUser.status !== 'active') {
        throw new AppError('INVALID_CREDENTIALS', 'Username or password is incorrect', 401);
      }
      if (currentUser.merchantId) {
        findMerchantOrThrow(state, currentUser.merchantId, { requireActive: true });
      }
      const now = new Date().toISOString();
      state.adminSessions = state.adminSessions.filter((session) => Date.parse(session.expiresAt) > Date.now());
      state.adminSessions.push({
        id: randomUUID(),
        userId: currentUser.id,
        tokenDigest,
        createdAt: now,
        expiresAt,
      });
      currentUser.lastLoginAt = now;
      currentUser.updatedAt = now;
      AuditService.append(state, {
        actor: currentUser,
        merchantId: currentUser.merchantId,
        action: 'auth.login',
        resourceType: 'session',
      });
      return presentUser(currentUser);
    });

    return { token, tokenType: 'Bearer', expiresAt, user };
  }

  async authenticate(token) {
    if (!token || typeof token !== 'string') {
      throw new AppError('UNAUTHORIZED', 'A bearer token is required', 401);
    }
    const tokenDigest = digestSecret(this.rootSecret, 'admin-session', token);
    return this.store.read((state) => {
      const session = state.adminSessions.find((item) => item.tokenDigest === tokenDigest);
      if (!session || Date.parse(session.expiresAt) <= Date.now()) {
        throw new AppError('UNAUTHORIZED', 'The administrator session is invalid or expired', 401);
      }
      const user = state.users.find((item) => item.id === session.userId);
      if (!user || user.status !== 'active') {
        throw new AppError('UNAUTHORIZED', 'The administrator account is unavailable', 401);
      }
      if (user.merchantId) {
        findMerchantOrThrow(state, user.merchantId, { requireActive: true });
      }
      return presentUser(user);
    });
  }

  async logout(user, token) {
    const tokenDigest = digestSecret(this.rootSecret, 'admin-session', token);
    await this.store.transaction((state) => {
      state.adminSessions = state.adminSessions.filter((session) => session.tokenDigest !== tokenDigest);
      AuditService.append(state, {
        actor: user,
        merchantId: user.merchantId,
        action: 'auth.logout',
        resourceType: 'session',
      });
    });
  }

  async changePassword(actor, input) {
    const currentPassword = validatePassword(input.currentPassword, 'currentPassword');
    const newPassword = validatePassword(input.newPassword, 'newPassword');
    const snapshot = await this.store.read((state) => state.users.find(
      (user) => user.id === actor.id,
    ) ?? null);
    if (!snapshot || snapshot.status !== 'active') {
      throw new AppError('UNAUTHORIZED', 'The administrator account is unavailable', 401);
    }
    if (!await verifyPassword(currentPassword, snapshot.passwordHash)) {
      throw new AppError('CURRENT_PASSWORD_INVALID', 'The current password is incorrect', 400);
    }
    if (await verifyPassword(newPassword, snapshot.passwordHash)) {
      throw new AppError('PASSWORD_UNCHANGED', 'The new password must be different', 409);
    }
    const passwordHash = await hashPassword(newPassword);

    return this.store.transaction((state) => {
      const user = state.users.find((item) => item.id === actor.id);
      if (!user || user.status !== 'active') {
        throw new AppError('UNAUTHORIZED', 'The administrator account is unavailable', 401);
      }
      if (user.passwordHash !== snapshot.passwordHash) {
        throw new AppError('PASSWORD_CHANGED_RETRY', 'The password was changed by another request', 409);
      }
      user.passwordHash = passwordHash;
      user.updatedAt = new Date().toISOString();
      const previousSessionCount = state.adminSessions.length;
      state.adminSessions = state.adminSessions.filter((session) => session.userId !== user.id);
      AuditService.append(state, {
        actor: user,
        merchantId: user.merchantId,
        action: 'auth.password.change',
        resourceType: 'user',
        resourceId: user.id,
      });
      return {
        passwordChanged: true,
        sessionsRevoked: previousSessionCount - state.adminSessions.length,
      };
    });
  }

  async resetMerchantUserPassword(actor, userId, input) {
    assertRole(actor, [Roles.PLATFORM_ADMIN, Roles.MERCHANT_ADMIN]);
    const targetId = requireString(userId, 'userId', { min: 36, max: 36 });
    const newPassword = validatePassword(input.newPassword, 'newPassword');
    const snapshot = await this.store.read((state) => state.users.find(
      (user) => user.id === targetId,
    ) ?? null);
    if (!snapshot || !snapshot.merchantId) {
      throw new AppError('USER_NOT_FOUND', 'Merchant user was not found', 404);
    }
    assertMerchantAccess(actor, snapshot.merchantId);
    if (snapshot.id === actor.id) {
      throw new AppError('USE_SELF_PASSWORD_CHANGE', 'Use the self-service password endpoint', 409);
    }
    if (await verifyPassword(newPassword, snapshot.passwordHash)) {
      throw new AppError('PASSWORD_UNCHANGED', 'The new password must be different', 409);
    }
    const passwordHash = await hashPassword(newPassword);

    return this.store.transaction((state) => {
      const user = state.users.find((item) => item.id === targetId);
      if (!user || !user.merchantId) {
        throw new AppError('USER_NOT_FOUND', 'Merchant user was not found', 404);
      }
      assertMerchantAccess(actor, user.merchantId);
      if (user.passwordHash !== snapshot.passwordHash) {
        throw new AppError('PASSWORD_CHANGED_RETRY', 'The password was changed by another request', 409);
      }
      user.passwordHash = passwordHash;
      user.updatedAt = new Date().toISOString();
      const previousSessionCount = state.adminSessions.length;
      state.adminSessions = state.adminSessions.filter((session) => session.userId !== user.id);
      AuditService.append(state, {
        actor,
        merchantId: user.merchantId,
        action: 'merchant_user.password.reset',
        resourceType: 'user',
        resourceId: user.id,
      });
      return {
        user: presentUser(user),
        sessionsRevoked: previousSessionCount - state.adminSessions.length,
      };
    });
  }

  async createMerchantUser(actor, merchantId, input) {
    assertRole(actor, [Roles.PLATFORM_ADMIN, Roles.MERCHANT_ADMIN]);
    assertMerchantAccess(actor, merchantId);
    const credentials = validateCredentials(input);
    const displayName = requireString(input.displayName || credentials.username, 'displayName', {
      min: 1,
      max: 80,
    });
    const role = requireEnum(input.role || Roles.OPERATOR, 'role', [Roles.MERCHANT_ADMIN, Roles.OPERATOR]);
    const passwordHash = await hashPassword(credentials.password);

    return this.store.transaction((state) => {
      findMerchantOrThrow(state, merchantId, { requireActive: true });
      if (state.users.some((user) => user.usernameNormalized === credentials.username.toLowerCase())) {
        throw new AppError('USERNAME_EXISTS', 'Username already exists', 409);
      }
      const now = new Date().toISOString();
      const user = {
        id: randomUUID(),
        merchantId,
        username: credentials.username,
        usernameNormalized: credentials.username.toLowerCase(),
        displayName,
        passwordHash,
        role,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      };
      state.users.push(user);
      AuditService.append(state, {
        actor,
        merchantId,
        action: 'merchant_user.create',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { role },
      });
      return presentUser(user);
    });
  }

  async listMerchantUsers(actor, merchantId) {
    assertMerchantAccess(actor, merchantId);
    return this.store.read((state) => {
      findMerchantOrThrow(state, merchantId);
      return state.users.filter((user) => user.merchantId === merchantId).map(presentUser);
    });
  }
}
