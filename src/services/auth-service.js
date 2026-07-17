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
  constructor(store, rootSecret, config, securityState = null) {
    this.store = store;
    this.rootSecret = rootSecret;
    this.config = config;
    this.securityState = securityState;
  }

  async bootstrapPlatformAdmin(input) {
    const credentials = validateCredentials(input);
    const displayName = requireString(input.displayName || credentials.username, 'displayName', {
      min: 1,
      max: 80,
    });
    const passwordHash = await hashPassword(credentials.password);
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

    if (this.store.repositories?.auth) {
      return presentUser(await this.store.repositories.auth.bootstrapPlatformAdmin(user));
    }

    return this.store.transaction((state) => {
      if (state.users.some((user) => user.role === Roles.PLATFORM_ADMIN)) {
        throw new AppError('PLATFORM_ADMIN_EXISTS', 'A platform administrator already exists', 409);
      }
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
    const failureKey = `login-account:${credentials.username.toLowerCase()}`;
    const failureState = this.securityState
      ? await this.securityState.incrementRate(failureKey, 15 * 60)
      : { count: 1, retryAfter: 0 };
    if (failureState.count > 10) {
      throw new AppError('LOGIN_ACCOUNT_LOCKED', 'Too many failed login attempts for this account', 429, {
        retryAfter: failureState.retryAfter,
      });
    }
    const repository = this.store.repositories?.auth;
    const snapshot = repository
      ? await repository.findByUsername(credentials.username.toLowerCase())
      : await this.store.read((state) => state.users.find(
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
    const user = repository
      ? presentUser(await repository.finalizeLogin(snapshot.id, tokenDigest, expiresAt))
      : await this.store.transaction((state) => {
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

    // Author: 花落. A failed finalization must not erase the Redis login-failure window. MIT License.
    if (this.securityState) await this.securityState.clearRate(failureKey);

    return { token, tokenType: 'Bearer', expiresAt, user };
  }

  async authenticate(token) {
    if (!token || typeof token !== 'string') {
      throw new AppError('UNAUTHORIZED', 'A bearer token is required', 401);
    }
    const tokenDigest = digestSecret(this.rootSecret, 'admin-session', token);
    if (this.store.repositories?.auth) {
      return presentUser(await this.store.repositories.auth.authenticate(tokenDigest));
    }
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
    if (this.store.repositories?.auth) {
      await this.store.repositories.auth.logout(user, tokenDigest);
      return;
    }
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
    const repository = this.store.repositories?.auth;
    const snapshot = repository
      ? await repository.findUser(actor.id)
      : await this.store.read((state) => state.users.find(
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

    if (repository) {
      return repository.changePassword(actor, snapshot.passwordHash, passwordHash);
    }

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
    const repository = this.store.repositories?.auth;
    const snapshot = repository
      ? await repository.findUser(targetId)
      : await this.store.read((state) => state.users.find(
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

    if (repository) {
      const result = await repository.resetMerchantUserPassword(actor, targetId, snapshot.passwordHash, passwordHash);
      return { ...result, user: presentUser(result.user) };
    }

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

    if (this.store.repositories?.auth) {
      return presentUser(await this.store.repositories.auth.createMerchantUser(actor, user));
    }

    return this.store.transaction((state) => {
      findMerchantOrThrow(state, merchantId, { requireActive: true });
      if (state.users.some((user) => user.usernameNormalized === credentials.username.toLowerCase())) {
        throw new AppError('USERNAME_EXISTS', 'Username already exists', 409);
      }
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
    if (this.store.repositories?.auth) {
      return (await this.store.repositories.auth.listMerchantUsers(actor, merchantId)).map(presentUser);
    }
    return this.store.read((state) => {
      findMerchantOrThrow(state, merchantId);
      return state.users.filter((user) => user.merchantId === merchantId).map(presentUser);
    });
  }


  async setUserStatus(actor, userId, requestedStatus) {
    assertRole(actor, [Roles.PLATFORM_ADMIN, Roles.MERCHANT_ADMIN]);
    const status = requireEnum(requestedStatus, 'status', ['active', 'disabled']);
    if (this.store.repositories?.auth) {
      const result = await this.store.repositories.auth.setUserStatus(actor, userId, status);
      return { ...result, user: presentUser(result.user) };
    }
    return this.store.transaction((state) => {
      const user = state.users.find((item) => item.id === userId && item.merchantId);
      if (!user) throw new AppError('USER_NOT_FOUND', 'Merchant user was not found', 404);
      assertMerchantAccess(actor, user.merchantId);
      if (user.id === actor.id && status === 'disabled') {
        throw new AppError('SELF_DISABLE_FORBIDDEN', 'You cannot disable your own account', 409);
      }
      user.status = status;
      user.updatedAt = new Date().toISOString();
      const before = state.adminSessions.length;
      if (status === 'disabled') {
        state.adminSessions = state.adminSessions.filter((session) => session.userId !== user.id);
      }
      AuditService.append(state, {
        actor,
        merchantId: user.merchantId,
        action: 'merchant_user.status.update',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { status },
      });
      return { user: presentUser(user), sessionsRevoked: before - state.adminSessions.length };
    });
  }
}
