/**
 * quizzes.ts — Carga y valida los cuestionarios del disco AL ARRANCAR.
 *
 * Si un JSON esta mal formado o una pregunta no tiene exactamente una opcion
 * correcta, el proceso NO levanta. Es deliberado: prefiero un servidor que no
 * arranca a un servidor que revela la respuesta equivocada delante de la clase.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuiz, type Quiz } from '@ingconoc/shared';

const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

export function loadQuizzes(dir: string = DATA_DIR): Map<string, Quiz> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    throw new Error(`No hay cuestionarios en ${dir}`);
  }

  const quizzes = new Map<string, Quiz>();
  const problems: string[] = [];

  for (const file of files) {
    const path = join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      problems.push(`${file}: JSON ilegible — ${(err as Error).message}`);
      continue;
    }
    try {
      const quiz = parseQuiz(raw);
      if (quizzes.has(quiz.id)) {
        problems.push(`${file}: id de cuestionario duplicado "${quiz.id}"`);
        continue;
      }
      quizzes.set(quiz.id, quiz);
    } catch (err) {
      problems.push(`${file}: ${(err as Error).message}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Cuestionarios invalidos, no arranco:\n${problems.join('\n')}`);
  }
  return quizzes;
}
