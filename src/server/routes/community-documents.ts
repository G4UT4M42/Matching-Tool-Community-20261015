import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { CommunityDocumentService, type Principal } from '../../community/documents/service.js';
import { DocumentInputError, MAX_DOCUMENT_BYTES } from '../../community/documents/recognition.js';

export type DocumentPermission = 'documents:read' | 'documents:write';
export function createCommunityDocumentsRouter(service: CommunityDocumentService, authorize: (principal: Principal, permission: DocumentPermission) => boolean): Router {
  const router = Router();
  const principal = (response: Response) => response.locals.communityPrincipal as Principal | undefined;
  const gate = (permission: DocumentPermission) => (_request: Request, response: Response, next: NextFunction) => {
    const owner = principal(response);
    if (!owner?.subject || !owner.workspace_id) { response.status(401).json({ code: 'AUTHENTICATION_REQUIRED' }); return; }
    if (!authorize(owner, permission)) { response.status(403).json({ code: 'FORBIDDEN' }); return; }
    next();
  };
  const handle = (work: (request: Request, response: Response) => Promise<void>) => (request: Request, response: Response) => { void work(request, response).catch(error => {
    const code = error instanceof DocumentInputError ? error.code : 'DOCUMENT_OPERATION_FAILED';
    const status = code === 'NOT_FOUND' ? 404 : code === 'MATCHED_EVIDENCE' || code === 'INVALID_STATUS' ? 409 : error instanceof DocumentInputError ? 400 : 500;
    response.status(status).json({ code, error: error instanceof DocumentInputError ? error.message : 'Document operation failed' });
  }); };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 1, parts: 2, fieldNameSize: 64, fieldSize: 180 } }).single('file');
  router.get('/', gate('documents:read'), handle(async (request, response) => { response.json({ items: await service.list(principal(response)!, String(request.query.q ?? '')) }); }));
  router.post('/upload', gate('documents:write'), (request, response) => upload(request, response, error => {
    if (error) { response.status(error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ code: 'INVALID_UPLOAD' }); return; }
    if (!request.file) { response.status(400).json({ code: 'INVALID_UPLOAD' }); return; }
    const buffer = request.file.buffer;
    void service.upload(principal(response)!, buffer, request.file.originalname, typeof request.body?.source_id === 'string' ? request.body.source_id : undefined)
      .then(result => response.status(result.duplicate ? 200 : 201).json(result))
      .catch(error => response.status(error instanceof DocumentInputError ? 400 : 500).json({ code: error instanceof DocumentInputError ? error.code : 'DOCUMENT_OPERATION_FAILED', error: error instanceof DocumentInputError ? error.message : 'Document upload failed' }))
      .finally(() => buffer.fill(0));
  }));
  const tableUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5_000_000, files: 1, fields: 1, parts: 2, fieldNameSize: 64, fieldSize: 20 } }).single('file');
  router.post('/import/:kind', gate('documents:write'), (request, response) => tableUpload(request, response, error => {
    if (error || !request.file || !['income','invoice'].includes(String(request.params.kind))) { response.status(error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ code: 'INVALID_UPLOAD' }); return; }
    const buffer = request.file.buffer;
    void service.importTable(principal(response)!, buffer, request.file.originalname, String(request.params.kind) as 'income' | 'invoice')
      .then(result => response.json(result))
      .catch(error => response.status(error instanceof DocumentInputError ? 400 : 500).json({ code: error instanceof DocumentInputError ? error.code : 'DOCUMENT_OPERATION_FAILED', error: error instanceof DocumentInputError ? error.message : 'Table import failed' }))
      .finally(() => buffer.fill(0));
  }));
  router.get('/:id', gate('documents:read'), handle(async (request, response) => { response.json(await service.get(principal(response)!, String(request.params.id))); }));
  router.get('/:id/content', gate('documents:read'), handle(async (request, response) => {
    const { record, buffer } = await service.download(principal(response)!, String(request.params.id));
    response.setHeader('Content-Type', record.mime);
    response.setHeader('Content-Length', buffer.length);
    const extension = record.mime === 'application/pdf' ? 'pdf' : record.mime === 'image/png' ? 'png' : record.mime === 'image/jpeg' ? 'jpg' : record.mime === 'text/csv' ? 'csv' : record.mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? 'xlsx' : 'bin';
    response.setHeader('Content-Disposition', `${record.mime === 'application/pdf' || record.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename="document.${extension}"`);
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(buffer);
  }));
  router.put('/:id/fields', gate('documents:write'), handle(async (request, response) => { response.json(await service.correct(principal(response)!, String(request.params.id), request.body ?? {})); }));
  router.post('/:id/confirm', gate('documents:write'), handle(async (request, response) => { response.json(await service.confirm(principal(response)!, String(request.params.id))); }));
  for (const action of ['reject', 'archive', 'restore'] as const) router.post(`/:id/${action}`, gate('documents:write'), handle(async (request, response) => { response.json(await service.disposition(principal(response)!, String(request.params.id), action)); }));
  return router;
}
