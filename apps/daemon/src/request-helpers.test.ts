import {
  readJsonObject,
  readOptionalJsonContent,
  readSpliceRequest,
  requestTextContent
} from './request-helpers.js';

describe('request helpers', () => {
  it.each([
    [{ baseline: 'b', old_text: 'old', new_text: 'new', before: 1 }, 'before must be a string when provided'],
    [{ baseline: 'b', old_text: 'old', new_text: 'new', after: false }, 'after must be a string when provided'],
    [{ baseline: 'b', old_text: 'old', new_text: 'new', occurrence: 1.5 }, 'occurrence must be an integer when provided']
  ])('rejects malformed optional splice fields', (body, message) => {
    expect(readSpliceRequest({ body })).toEqual({
      ok: false,
      error: 'invalid_request',
      message
    });
  });

  it('returns undefined for optional JSON content on non-JSON requests', async () => {
    await expect(readOptionalJsonContent(new Request('http://localhost', {
      method: 'POST',
      body: 'plain text'
    }))).resolves.toBeUndefined();
  });

  it('rejects malformed JSON object bodies', async () => {
    await expect(readJsonObject(new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]'
    }))).resolves.toEqual({
      ok: false,
      error: 'invalid_request',
      message: 'request body must be a JSON object'
    });
  });

  it('reads plain text request content without JSON validation', async () => {
    await expect(requestTextContent(new Request('http://localhost', {
      method: 'PUT',
      body: 'plain'
    }))).resolves.toEqual({ ok: true, content: 'plain' });
  });
});
