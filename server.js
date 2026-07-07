import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import 'dotenv/config';

const API_KEY = process.env.ASSEMBLY_API_KEY;
const BASE_URL = 'https://open.assembly.go.kr/portal/openapi';

if (!API_KEY) {
  console.warn(
    '[경고] ASSEMBLY_API_KEY 환경변수가 설정되지 않았습니다. ' +
    '열린국회정보 Open API 호출 시 sample 키로 처리되어 10건만 반환됩니다.'
  );
}

// ---------------------------------------------------------------------------
// 2026-07 기준 조사된 의안 관련 주요 엔드포인트 목록
// (열린국회정보 Open API 목록 페이지 및 공개된 개발 참고문서를 근거로 정리.
//  정확한 요청/응답 필드는 open.assembly.go.kr 로그인 후 각 서비스 페이지의
//  'API' 탭 명세서에서 재확인 권장 - 특히 TVBPMBILL11, ALLBILL은 필드명 추정치임)
// ---------------------------------------------------------------------------
const KNOWN_ENDPOINTS = {
  TVBPMBILL11: {
    name: '의안검색 (법률안 심사 및 처리)',
    desc: '가장 포괄적인 의안 검색/처리현황 API. 22대 기준 약 11만 건. 소관위원회·처리상태 등 포함 추정.',
    required: [],
    source: '원본시스템: 의안정보시스템',
  },
  ALLBILL: {
    name: '의안정보 통합 API',
    desc: '의안번호(BILL_NO) 기준 통합 정보 조회. 의안종류·관련 링크 포함.',
    required: ['BILL_NO'],
  },
  BILLINFODETAIL: {
    name: '의안 상세정보',
    desc: '의안ID(BILL_ID) 기준 상세 정보 조회.',
    required: ['BILL_ID'],
  },
  BILLINFOPPSR: {
    name: '의안 제안자정보',
    desc: '의안ID(BILL_ID) 기준 제안자 정보 조회.',
    required: ['BILL_ID'],
  },
  BILLLWJUDGECONF: {
    name: '법사위 회의정보',
    desc: '의안ID(BILL_ID) 기준 법제사법위원회 심사 회의정보.',
    required: ['BILL_ID'],
  },
  BILLJUDGECONF: {
    name: '위원회심사 회의정보',
    desc: '의안ID(BILL_ID) 기준 소관위원회 심사 회의정보.',
    required: ['BILL_ID'],
  },
  nzmimeepazxkubdpn: {
    name: '국회의원 발의법률안',
    desc: '대수(AGE) 기준 의원 발의 법률안. 대표발의자/공동발의자 구분 가능(필드명 확인됨).',
    required: ['AGE'],
  },
  nwbqublzajtcqpdae: {
    name: '계류의안',
    desc: '현재 계류 중인 의안 목록. 필수인자 없음.',
    required: [],
  },
  nzpltgfqabtcpsmai: {
    name: '처리의안',
    desc: '대수(AGE) 기준 처리 완료된 의안.',
    required: ['AGE'],
  },
  nxjuyqnxadtotdrbw: {
    name: '최근 본회의처리 의안',
    desc: '대수(AGE) 기준 최근 본회의 처리 의안.',
    required: ['AGE'],
  },
  nkalemivaqmoibxro: {
    name: '본회의 처리안건_법률안',
    desc: '대수(AGE) 기준 본회의에서 처리된 법률안.',
    required: ['AGE'],
  },
};

/**
 * 열린국회정보 Open API 공통 호출 함수
 */
async function callAssemblyApi(endpointId, params = {}, { pIndex = 1, pSize = 20 } = {}) {
  const url = new URL(`${BASE_URL}/${endpointId}`);
  url.searchParams.set('KEY', API_KEY || 'sample');
  url.searchParams.set('Type', 'json');
  url.searchParams.set('pIndex', String(pIndex));
  url.searchParams.set('pSize', String(pSize));
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  let res;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    return { error: `네트워크 오류: ${err.message}`, url: url.toString() };
  }

  const rawText = await res.text();
  if (!res.ok) {
    return { error: `HTTP ${res.status}`, body: rawText.slice(0, 1000), url: url.toString() };
  }

  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    // 인증키 오류 등은 종종 JSON이 아닌 형식으로 내려오는 경우가 있어 원문을 그대로 반환
    return { error: '응답이 JSON 형식이 아닙니다 (인증키 오류일 수 있음)', raw: rawText.slice(0, 1000), url: url.toString() };
  }

  // 공공데이터포털 계열 공통 응답 구조 파싱 시도: { [endpointId]: [{head:[...]}, {row:[...]}] }
  const container = json[endpointId];
  if (Array.isArray(container)) {
    const headBlock = container.find((b) => b.head);
    const rowBlock = container.find((b) => b.row);
    const resultInfo = headBlock?.head?.find((h) => h.RESULT)?.RESULT;
    const totalCount = headBlock?.head?.find((h) => 'list_total_count' in h)?.list_total_count;
    return {
      totalCount,
      resultCode: resultInfo?.CODE,
      resultMessage: resultInfo?.MESSAGE,
      rows: rowBlock?.row ?? [],
    };
  }

  // 예상 구조가 아니면 원본 그대로 반환 (에러 메시지 등이 다른 형태로 올 수 있음)
  return { raw: json };
}

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function getServer() {
  const server = new McpServer(
    { name: 'assembly-bill-info', version: '1.0.0' },
    { capabilities: {} }
  );

  server.registerTool(
    'list_available_endpoints',
    {
      description:
        '이 MCP가 알고 있는 열린국회정보(국회 의안정보) Open API 엔드포인트 목록과 설명을 반환합니다. ' +
        '다른 도구를 쓰기 전에 어떤 정보를 어떤 도구로 조회할 수 있는지 확인할 때 사용하세요.',
      inputSchema: {},
    },
    async () => textResult(KNOWN_ENDPOINTS)
  );

  server.registerTool(
    'search_bills',
    {
      description:
        '의안검색(TVBPMBILL11) API로 법률안을 검색합니다. 심사 진행상황·처리상태(가결/부결/계류 등)를 ' +
        '포함한 가장 포괄적인 의안 데이터입니다. 정확한 필드명이 검증되지 않았으므로, 결과가 비어있거나 ' +
        '예상과 다르면 extra_params로 다른 필드명을 시도해보세요.',
      inputSchema: {
        bill_name: z.string().optional().describe('법률안명 (부분검색 추정)'),
        committee: z.string().optional().describe('소관위원회명'),
        age: z.string().optional().describe("대수, 예: '22'"),
        page_index: z.number().optional().default(1),
        page_size: z.number().optional().default(20),
        extra_params: z
          .record(z.string())
          .optional()
          .describe('위 필드로 안 될 경우 시도할 추가 요청 파라미터 (예: {"PROC_RESULT_CD":"원안가결"})'),
      },
    },
    async ({ bill_name, committee, age, page_index, page_size, extra_params }) => {
      const params = {
        BILL_NAME: bill_name,
        COMMITTEE: committee,
        AGE: age,
        ...extra_params,
      };
      const result = await callAssemblyApi('TVBPMBILL11', params, { pIndex: page_index, pSize: page_size });
      return textResult(result);
    }
  );

  server.registerTool(
    'get_bill_integrated_info',
    {
      description: '의안정보 통합 API(ALLBILL)로 의안번호 기준 통합 정보(의안종류, 관련 링크 등)를 조회합니다.',
      inputSchema: {
        bill_no: z.string().describe("의안번호 (필수), 예: '2211084'"),
      },
    },
    async ({ bill_no }) => {
      const result = await callAssemblyApi('ALLBILL', { BILL_NO: bill_no });
      return textResult(result);
    }
  );

  server.registerTool(
    'get_bill_detail',
    {
      description: '의안 상세정보(BILLINFODETAIL)로 의안ID 기준 상세정보를 조회합니다.',
      inputSchema: {
        bill_id: z.string().describe('의안ID (필수)'),
      },
    },
    async ({ bill_id }) => {
      const result = await callAssemblyApi('BILLINFODETAIL', { BILL_ID: bill_id });
      return textResult(result);
    }
  );

  server.registerTool(
    'search_member_proposed_bills',
    {
      description:
        '국회의원 발의법률안 API로 의원이 발의한 법률안을 검색합니다. 대표발의자/공동발의자 구분이 ' +
        '가능한 유일한 API입니다 (필드명 검증됨).',
      inputSchema: {
        age: z.string().describe("대수 (필수), 예: '22'"),
        bill_id: z.string().optional().describe('의안ID'),
        bill_no: z.string().optional().describe('의안번호'),
        bill_name: z.string().optional().describe('법률안명'),
        committee: z.string().optional().describe('소관위원회명'),
        proc_result: z.string().optional().describe('처리상태'),
        proposer: z.string().optional().describe('제안자명 (대표발의자 검색시 사용)'),
        page_index: z.number().optional().default(1),
        page_size: z.number().optional().default(100),
      },
    },
    async ({ age, bill_id, bill_no, bill_name, committee, proc_result, proposer, page_index, page_size }) => {
      const params = {
        AGE: age,
        BILL_ID: bill_id,
        BILL_NO: bill_no,
        BILL_NAME: bill_name,
        COMMITTEE: committee,
        PROC_RESULT: proc_result,
        PROPOSER: proposer,
      };
      const result = await callAssemblyApi('nzmimeepazxkubdpn', params, { pIndex: page_index, pSize: page_size });
      return textResult(result);
    }
  );

  server.registerTool(
    'call_assembly_openapi',
    {
      description:
        '위 전용 도구에 없는 다른 열린국회정보 Open API를 직접 호출하는 범용 도구입니다. ' +
        'list_available_endpoints로 확인한 endpoint_id와 필요한 파라미터를 직접 지정하세요.',
      inputSchema: {
        endpoint_id: z.string().describe("API 엔드포인트 ID, 예: 'nwbqublzajtcqpdae' (계류의안)"),
        params: z.record(z.string()).optional().describe('요청 파라미터 key-value (AGE, BILL_ID, BILL_NO 등)'),
        page_index: z.number().optional().default(1),
        page_size: z.number().optional().default(20),
      },
    },
    async ({ endpoint_id, params, page_index, page_size }) => {
      const result = await callAssemblyApi(endpoint_id, params || {}, { pIndex: page_index, pSize: page_size });
      return textResult(result);
    }
  );

  return server;
}

const allowedHosts = process.env.ALLOWED_HOSTS ? process.env.ALLOWED_HOSTS.split(',') : undefined;
const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts });

app.get('/', (req, res) => res.status(200).send('assembly-bill-info MCP server OK'));

app.post('/mcp', async (req, res) => {
  const server = getServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error('MCP 요청 처리 오류:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.get('/mcp', (req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
});
app.delete('/mcp', (req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`assembly-bill-info MCP server listening on port ${PORT}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
