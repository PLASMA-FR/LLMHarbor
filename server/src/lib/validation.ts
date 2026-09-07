import type { Response } from 'express';
import type { ZodError, ZodIssue } from 'zod';

export interface ValidationDetail {
  path: string;
  code: string;
  message: string;
}

/** Field errors never serialize submitted values, credentials, or entire bodies. */
export function validationDetails(error: ZodError): ValidationDetail[] {
  const flatten = (issue: ZodIssue): ZodIssue[] =>
    issue.code === 'invalid_union'
      ? issue.unionErrors.flatMap((error) => error.issues.flatMap(flatten))
      : [issue];
  const details = error.issues.flatMap(flatten).map((issue) => ({
    path: issue.path.map(String).join('.') || 'body',
    code: issue.code,
    message:
      issue.code === 'invalid_enum_value'
        ? `Choose one of: ${issue.options.join(', ')}.`
        : issue.code === 'invalid_literal'
          ? `Expected ${JSON.stringify(issue.expected)}.`
          : issue.message,
  }));
  return [...new Map(details.map((detail) => [`${detail.path}:${detail.message}`, detail])).values()].slice(
    0,
    32,
  );
}

export function sendValidationError(res: Response, error: ZodError): void {
  const details = validationDetails(error);
  res.status(400).json({
    error: {
      message: `Invalid request. ${details
        .slice(0, 3)
        .map((detail) => `${detail.path}: ${detail.message}`)
        .join(' ')}`,
      type: 'invalid_request_error',
      code: 'validation_error',
      param: details[0]?.path ?? null,
      details,
    },
  });
}
