import {
  DOCUMENT_BYTES_LIMIT,
  SPLICE_BYTES_LIMIT,
  type AnchoredSpliceRequest,
  type AnchoredSpliceResult
} from './splice.js';

interface AnchoredSpliceContractCase {
  name: string;
  initialContent: string;
  request: AnchoredSpliceRequest;
  expected: AnchoredSpliceResult;
}

export const anchoredSpliceContractCases: AnchoredSpliceContractCase[] = [
  {
    name: 'empty documents accept the first content with normalized line endings',
    initialContent: '',
    request: { oldText: '', newText: 'first\r\ncontent\r' },
    expected: { ok: true, content: 'first\ncontent\n' }
  },
  {
    name: 'empty documents accept an empty no-op',
    initialContent: '',
    request: { oldText: '', newText: '' },
    expected: { ok: true, content: '' }
  },
  {
    name: 'empty needles cannot replace nonempty documents',
    initialContent: 'existing content',
    request: { oldText: '', newText: 'replacement' },
    expected: { ok: false, rejected: 'not_found' }
  },
  {
    name: 'whitespace documents are not empty',
    initialContent: '\n',
    request: { oldText: '', newText: 'replacement' },
    expected: { ok: false, rejected: 'not_found' }
  },
  {
    name: 'empty documents still require supplied anchors to match',
    initialContent: '',
    request: { before: 'missing', oldText: '', newText: 'replacement' },
    expected: { ok: false, rejected: 'not_found' }
  },
  {
    name: 'anchored insertions into nonempty documents remain supported',
    initialContent: 'before after',
    request: { before: 'before ', oldText: '', after: 'after', newText: 'inserted ' },
    expected: { ok: true, content: 'before inserted after' }
  },
  {
    name: 'empty document insertions still enforce the splice size limit',
    initialContent: '',
    request: { oldText: '', newText: 'x'.repeat(SPLICE_BYTES_LIMIT + 1) },
    expected: { ok: false, rejected: 'too_large_splice', limit_bytes: SPLICE_BYTES_LIMIT }
  },
  {
    name: 'occurrence anchoring replaces the requested match',
    initialContent: 'foo bar foo baz foo',
    request: {
      oldText: 'foo',
      newText: 'FOO',
      occurrence: 2
    },
    expected: { ok: true, content: 'foo bar FOO baz foo' }
  },
  {
    name: 'before and after anchors disambiguate the match',
    initialContent: 'aa aa aa',
    request: {
      before: 'aa ',
      oldText: 'aa',
      after: ' aa',
      newText: 'XX'
    },
    expected: { ok: true, content: 'aa XX aa' }
  },
  {
    name: 'missing text is reported as not_found',
    initialContent: 'hello',
    request: {
      oldText: 'missing',
      newText: 'x'
    },
    expected: { ok: false, rejected: 'not_found' }
  },
  {
    name: 'oversized splice input is rejected before matching',
    initialContent: 'x',
    request: {
      oldText: 'x'.repeat(SPLICE_BYTES_LIMIT + 1),
      newText: 'y'
    },
    expected: {
      ok: false,
      rejected: 'too_large_splice',
      limit_bytes: SPLICE_BYTES_LIMIT
    }
  },
  {
    name: 'oversized resulting document is rejected',
    initialContent: `x${'a'.repeat(DOCUMENT_BYTES_LIMIT - 1)}`,
    request: {
      oldText: 'x',
      newText: 'yy'
    },
    expected: {
      ok: false,
      rejected: 'too_large_document',
      current_bytes: DOCUMENT_BYTES_LIMIT + 1,
      limit_bytes: DOCUMENT_BYTES_LIMIT
    }
  }
];
