import type { Json, RequestOptions } from './index';
export type OperationSchema = {
  type: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
  properties?: Record<string, OperationSchema>; required?: string[]; additionalProperties?: false;
  items?: OperationSchema; enum?: (string | number | boolean | null)[];
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
  minItems?: number; maxItems?: number; description?: string;
};
export type Operation = { id: string; permission: string; summary?: string; input?: OperationSchema; output?: OperationSchema; errors?: string[] };
export function validateSchema(schema: unknown): OperationSchema;
export function validateValue(schema: OperationSchema, value: unknown, code?: string): Json;
export function validateOperation(value: unknown): Operation;
export function operationInput(operation: Operation, input: unknown): Json;
export function operationOutput(operation: Operation, output: unknown): Json;
export function createOperationClient(options: {
  actions: Operation[];
  invoke(action: string, input: Json, options?: RequestOptions): Promise<unknown>;
}): Readonly<Record<string, (input?: Record<string, Json>, options?: RequestOptions) => Promise<Json>>>;
