import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import type { SessionState } from '../../shared/reader.js';

const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);

export function isDevelopmentRequest(req: Request, config: AppConfig): boolean {
  if (config.authMode !== 'development' || config.nodeEnv === 'production') return false;
  const hostname = req.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return config.nodeEnv === 'test' || loopbackHosts.has(hostname);
}

export function developmentSession(req: Request, config: AppConfig): SessionState {
  const authenticated = isDevelopmentRequest(req, config);
  return {
    authenticated,
    mode: config.authMode,
    setupRequired: config.authMode === 'passkey',
    user: authenticated ? { id: 'development-user', displayName: 'Paul' } : null,
  };
}

export function requireDevelopmentUser(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isDevelopmentRequest(req, config)) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    res.locals.user = { id: 'development-user', displayName: 'Paul' };
    next();
  };
}
