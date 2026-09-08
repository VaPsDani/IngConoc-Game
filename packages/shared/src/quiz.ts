/**
 * quiz.ts — Modelo del cuestionario y la frontera publica/privada.
 *
 * REGLA DURA: lo que viaja al celular del jugador NUNCA lleva `isCorrect`.
 *
 * Se garantiza por dos vias independientes:
 *  1. En runtime: `toPublic()` CONSTRUYE el objeto campo por campo. No copia,
 *     no hace spread, no borra. Un campo nuevo en `QuizOption` no se filtra
 *     solo: hay que anadirlo aqui a mano.
 *  2. En compilacion: `PublicQuestion` lleva una marca con un `unique symbol`
 *     que solo `toPublic()` puede poner. Sin la marca, TypeScript no deja
 *     asignar un `Question` donde se espera un `PublicQuestion` — que es
 *     exactamente el accidente que se quiere impedir, porque el chequeo de
 *     propiedades sobrantes de TS NO lo detecta al asignar variables.
 */

export type QuestionId = string;
export type OptionId = string;
export type OptionLabel = 'A' | 'B' | 'C' | 'D';

// --- Lado privado: vive solo en el servidor -------------------------------

export type QuizOption = {
  id: OptionId;
  label: OptionLabel;
  text: string;
  color: string;
  isCorrect: boolean;
};

export type Question = {
  id: QuestionId;
  prompt: string;
  timeLimitSec: number;
  options: QuizOption[];
};

export type Quiz = {
  id: string;
  title: string;
  questions: Question[];
};

// --- Lado publico: esto si cruza el cable ---------------------------------

declare const PUBLIC_BRAND: unique symbol;

export type PublicOption = {
  id: OptionId;
  label: OptionLabel;
  text: string;
  color: string;
};

export type PublicQuestion = {
  /** Marca de origen. Solo `toPublic()` la coloca. No existe en runtime. */
  readonly [PUBLIC_BRAND]: true;
  id: QuestionId;
  /** 0-based. */
  index: number;
  total: number;
  prompt: string;
  timeLimitMs: number;
  options: PublicOption[];
};

/**
 * UNICO camino de salida de una pregunta hacia un cliente.
 *
 * El `as` de la ultima linea es el unico cast de todo el modulo y existe solo
 * para colocar la marca, que no tiene representacion en runtime. El objeto se
 * arma campo por campo justo encima.
 */
export function toPublic(q: Question, index: number, total: number): PublicQuestion {
  const options: PublicOption[] = q.options.map((o) => ({
    id: o.id,
    label: o.label,
    text: o.text,
    color: o.color,
  }));

  return {
    id: q.id,
    index,
    total,
    prompt: q.prompt,
    timeLimitMs: q.timeLimitSec * 1000,
    options,
  } as PublicQuestion;
}

/** La opcion correcta de una pregunta. Solo para uso del servidor. */
export function correctOptionId(q: Question): OptionId {
  const correct = q.options.find((o) => o.isCorrect);
  if (!correct) throw new Error(`Pregunta ${q.id} sin opcion correcta`);
  return correct.id;
}

// --- Validacion del JSON del cuestionario ---------------------------------

export type QuizValidationError = { path: string; message: string };

const LABELS: OptionLabel[] = ['A', 'B', 'C', 'D'];
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Valida la forma del cuestionario. El servidor la corre al arrancar y se
 * niega a levantar si algo esta mal: mejor no arrancar que arrancar con una
 * pregunta sin respuesta correcta delante de 40 alumnos.
 */
export function validateQuiz(raw: unknown): QuizValidationError[] {
  const errors: QuizValidationError[] = [];
  const push = (path: string, message: string) => errors.push({ path, message });

  if (typeof raw !== 'object' || raw === null) {
    push('$', 'el cuestionario debe ser un objeto');
    return errors;
  }
  const quiz = raw as Record<string, unknown>;

  if (typeof quiz.id !== 'string' || quiz.id.length === 0) push('$.id', 'falta id');
  if (typeof quiz.title !== 'string' || quiz.title.length === 0) push('$.title', 'falta title');

  if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
    push('$.questions', 'debe ser un array con al menos una pregunta');
    return errors;
  }

  const seenQuestionIds = new Set<string>();

  quiz.questions.forEach((rawQ, qi) => {
    const at = `$.questions[${qi}]`;
    if (typeof rawQ !== 'object' || rawQ === null) {
      push(at, 'debe ser un objeto');
      return;
    }
    const q = rawQ as Record<string, unknown>;

    if (typeof q.id !== 'string' || q.id.length === 0) {
      push(`${at}.id`, 'falta id');
    } else if (seenQuestionIds.has(q.id)) {
      push(`${at}.id`, `id duplicado: ${q.id}`);
    } else {
      seenQuestionIds.add(q.id);
    }

    if (typeof q.prompt !== 'string' || q.prompt.trim().length === 0) {
      push(`${at}.prompt`, 'falta prompt');
    }

    if (typeof q.timeLimitSec !== 'number' || !Number.isFinite(q.timeLimitSec)) {
      push(`${at}.timeLimitSec`, 'debe ser un numero');
    } else if (q.timeLimitSec < 5 || q.timeLimitSec > 180) {
      push(`${at}.timeLimitSec`, 'fuera de rango [5, 180]');
    }

    if (!Array.isArray(q.options)) {
      push(`${at}.options`, 'debe ser un array');
      return;
    }
    if (q.options.length !== 4) {
      push(`${at}.options`, `debe tener exactamente 4 opciones, tiene ${q.options.length}`);
    }

    const seenOptionIds = new Set<string>();
    let correctCount = 0;

    q.options.forEach((rawO, oi) => {
      const oAt = `${at}.options[${oi}]`;
      if (typeof rawO !== 'object' || rawO === null) {
        push(oAt, 'debe ser un objeto');
        return;
      }
      const o = rawO as Record<string, unknown>;

      if (typeof o.id !== 'string' || o.id.length === 0) {
        push(`${oAt}.id`, 'falta id');
      } else if (seenOptionIds.has(o.id)) {
        push(`${oAt}.id`, `id duplicado: ${o.id}`);
      } else {
        seenOptionIds.add(o.id);
      }

      if (o.label !== LABELS[oi]) {
        push(`${oAt}.label`, `debe ser "${LABELS[oi]}" (por posicion), es ${JSON.stringify(o.label)}`);
      }
      if (typeof o.text !== 'string' || o.text.trim().length === 0) {
        push(`${oAt}.text`, 'falta text');
      }
      if (typeof o.color !== 'string' || !HEX.test(o.color)) {
        push(`${oAt}.color`, 'debe ser un hex #rrggbb');
      }
      if (typeof o.isCorrect !== 'boolean') {
        push(`${oAt}.isCorrect`, 'debe ser boolean');
      } else if (o.isCorrect) {
        correctCount++;
      }
    });

    if (correctCount !== 1) {
      push(`${at}.options`, `debe tener exactamente 1 opcion correcta, tiene ${correctCount}`);
    }
  });

  return errors;
}

/** Valida y devuelve el Quiz tipado, o lanza con un mensaje util. */
export function parseQuiz(raw: unknown): Quiz {
  const errors = validateQuiz(raw);
  if (errors.length > 0) {
    const detail = errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
    throw new Error(`Cuestionario invalido:\n${detail}`);
  }
  return raw as Quiz;
}
