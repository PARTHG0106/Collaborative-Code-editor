export type TextOperation = Array<number | string>;
export interface TextEdit { offset: number; length: number; text: string; }
export function operationBaseLength(operation: TextOperation): number;
export function applyOperation(content: string, operation: TextOperation): string;
export function operationFromSplices(contentLength: number, edits: TextEdit[]): TextOperation;
export function transformOperations(left: TextOperation, right: TextOperation): [TextOperation, TextOperation];
