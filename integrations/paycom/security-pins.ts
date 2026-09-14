import { z } from 'zod';

// Preserve the exact configured answers, including leading zeroes and spaces.
export const securityAnswersSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[^\r\n\0]+$/),
  )
  .length(5)
  .refine((answers) => new Set(answers).size === 5);
export const securityPath = '/v4/cl/web.php/security/security-question/login';
