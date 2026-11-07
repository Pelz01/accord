import type { Server } from 'node:http';
import type { ParsedDocument } from './documents.ts';
export function documentType(bytes: Buffer): 'application/pdf' | 'image/png' | 'image/jpeg';
export function parseDocument(bytes: Buffer): Promise<ParsedDocument>;
export function documentServer(): Server;
