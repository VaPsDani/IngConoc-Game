/**
 * validate.ts — Validacion de longitud y forma de TODO payload entrante.
 *
 * Socket.IO ya corta a 8 KB por mensaje, pero eso no impide que alguien mande
 * 8 KB de basura en un campo que espera 16 caracteres. Aqui se acota cada campo
 * ANTES de que toque la maquina de estados.
 *
 * Vive en shared para que el cliente pueda usar los mismos limites en sus
 * inputs y no mande nada que el servidor vaya a rechazar.
 */

import { isValidCode, normalizeCode } from './code.ts';

/** Tope de cualquier id que venga del cliente (uuid = 36). */
export const ID_MAX = 64;
/** Apodo antes de sanear: se deja margen para acentos y espacios de sobra. */
export const NICKNAME_RAW_MAX = 64;
export const HOST_TOKEN_LENGTH = 6;

export function isString(v: unknown, max: number, min = 1): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

/** Id opaco: solo caracteres seguros y acotado en longitud. */
export function isValidId(v: unknown): v is string {
  return isString(v, ID_MAX) && /^[A-Za-z0-9_.:-]+$/.test(v);
}

export function isValidNicknameInput(v: unknown): v is string {
  return isString(v, NICKNAME_RAW_MAX);
}

export function isValidCodeInput(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 32 && isValidCode(normalizeCode(v));
}

export function isValidHostToken(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 32) return false;
  const norm = normalizeCode(v);
  return norm.length === HOST_TOKEN_LENGTH && isValidCode(norm);
}

/** Numero finito dentro de un rango. NaN e Infinity fuera. */
export function isNumberIn(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

export type Validation = { ok: true } | { ok: false; field: string };

export function validateJoin(p: unknown): Validation {
  if (typeof p !== 'object' || p === null) return { ok: false, field: 'payload' };
  const { code, nickname } = p as Record<string, unknown>;
  if (!isValidCodeInput(code)) return { ok: false, field: 'code' };
  if (!isValidNicknameInput(nickname)) return { ok: false, field: 'nickname' };
  return { ok: true };
}

export function validateResume(p: unknown): Validation {
  if (typeof p !== 'object' || p === null) return { ok: false, field: 'payload' };
  const { sessionId, playerId, token } = p as Record<string, unknown>;
  if (!isValidId(sessionId)) return { ok: false, field: 'sessionId' };
  if (!isValidId(playerId)) return { ok: false, field: 'playerId' };
  if (!isValidId(token)) return { ok: false, field: 'token' };
  return { ok: true };
}

export function validateAnswer(p: unknown): Validation {
  if (typeof p !== 'object' || p === null) return { ok: false, field: 'payload' };
  const { questionId, optionId, precision, attempts } = p as Record<string, unknown>;
  if (!isValidId(questionId)) return { ok: false, field: 'questionId' };
  if (!isValidId(optionId)) return { ok: false, field: 'optionId' };
  // precision fuera de [0,1] no es un ataque, es un cliente viejo: se clampea
  // despues. Aqui solo se exige que sea un numero de verdad.
  if (!isNumberIn(precision, -1e6, 1e6)) return { ok: false, field: 'precision' };
  if (!isNumberIn(attempts, 0, 100_000)) return { ok: false, field: 'attempts' };
  return { ok: true };
}

export function validateCreateSession(p: unknown): Validation {
  if (typeof p !== 'object' || p === null) return { ok: false, field: 'payload' };
  const { quizId, hostKey } = p as Record<string, unknown>;
  if (!isValidId(quizId)) return { ok: false, field: 'quizId' };
  if (!isString(hostKey, 256)) return { ok: false, field: 'hostKey' };
  return { ok: true };
}

export function validateHostRecover(p: unknown): Validation {
  if (typeof p !== 'object' || p === null) return { ok: false, field: 'payload' };
  const { code, hostToken } = p as Record<string, unknown>;
  if (!isValidCodeInput(code)) return { ok: false, field: 'code' };
  if (!isValidHostToken(hostToken)) return { ok: false, field: 'hostToken' };
  return { ok: true };
}

export function validatePing(p: unknown): Validation {
  if (typeof p !== 'object' || p === null) return { ok: false, field: 'payload' };
  const { t0 } = p as Record<string, unknown>;
  if (!isNumberIn(t0, 0, 4e15)) return { ok: false, field: 't0' };
  return { ok: true };
}

export function validateKick(p: unknown): Validation {
  if (typeof p !== 'object' || p === null) return { ok: false, field: 'payload' };
  const { playerId } = p as Record<string, unknown>;
  if (!isValidId(playerId)) return { ok: false, field: 'playerId' };
  return { ok: true };
}

