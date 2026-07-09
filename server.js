import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import { XMLParser } from 'fast-xml-parser';
import 'dotenv/config';

const API_KEY = process.env.ASSEMBLY_API_KEY;
const BASE_URL = 'https://open.assembly.go.kr/portal/openapi';

const DATA_GO_KR_KEY = process.env.DATA_GO_KR_KEY;
const KOSIS_KEY = process.env.KOSIS_KEY;
const VWORLD_KEY = process.env.VWORLD_KEY;
const VWORLD_DOMAIN = process.env.VWORLD_DOMAIN; // 인증키 발급 시 등록한 도메인
const KEPCO_KEY = process.env.KEPCO_KEY;

/**
 * 쿼리스트링 빌더.
 * rawKeys에 지정된 키는 URL 인코딩하지 않고 그대로 붙인다.
 * (KOSIS 인증키는 Base64라 '='로 끝나고, itmId/objL은 '+'가 구분자로 쓰이므로
 *  인코딩하면 서버가 값을 다르게 해석함)
 */
function buildQuery(params, rawKeys = []) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) =>
      rawKeys.includes(k) ? `${k}=${v}` : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    )
    .join('&');
}

/** 응답에서 인증키를 마스킹 (로그·에러메시지 노출 방지) */
function maskKeys(str) {
  let out = str;
  for (const k of [DATA_GO_KR_KEY, KOSIS_KEY, VWORLD_KEY, KEPCO_KEY, API_KEY]) {
    if (k) out = out.split(k).join('***KEY***');
  }
  return out;
}

if (!API_KEY) {
  console.warn(
    '[경고] ASSEMBLY_API_KEY 환경변수가 설정되지 않았습니다. ' +
    '열린국회정보 Open API 호출 시 sample 키로 처리되어 10건만 반환됩니다.'
  );
}
if (!DATA_GO_KR_KEY) {
  console.warn('[경고] DATA_GO_KR_KEY 환경변수가 설정되지 않았습니다. 공공데이터포털 도구는 동작하지 않습니다.');
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

// ===========================================================================
// KOSIS (국가통계포털) — kosis.kr/openapi
// ---------------------------------------------------------------------------
// 인증키 파라미터명: apiKey. 출력포맷: format=json&jsonVD=Y
// [함정] 인증키가 Base64라 '='로 끝남 → URLSearchParams로 넣으면 '%3D'로 인코딩되어
//        인증 실패할 수 있음. 그래서 raw로 붙인다.
// [함정] itmId='T1+T2+', objL1='ALL' 등에서 '+'는 값 구분자. 인코딩하면 안 됨.
// [권장] KOSIS 사이트의 '통계표선택 → URL 생성'으로 만든 URL을 통째로 넘기는 방식이 가장 확실.
// ===========================================================================
const KOSIS_RAW_PARAMS = ['apiKey', 'itmId', 'objL1', 'objL2', 'objL3', 'objL4', 'objL5', 'objL6', 'objL7', 'objL8'];

const KOSIS_SERVICES = {
  'statisticsList.do': '통계목록 조회',
  'statisticsData.do': '통계자료 조회 (userStatsId 방식: 사이트에서 자료등록 후 사용)',
  'Param/statisticsParameterData.do': '통계자료 조회 (파라미터 방식: orgId+tblId 직접 지정)',
  'statisticsExplData.do': '통계설명자료 조회',
  'statisticsSearch.do': 'KOSIS 통합검색',
  'statisticsBigData.do': '대용량 통계자료 조회',
};

async function callKosisUrl(fullUrl) {
  if (!KOSIS_KEY) return { error: 'KOSIS_KEY 환경변수가 서버에 설정되어 있지 않습니다.' };

  // 기존 URL에 apiKey가 비어있거나 없으면 주입, 있으면 우리 키로 교체
  let u;
  try {
    u = new URL(fullUrl);
  } catch {
    return { error: `올바른 URL이 아닙니다: ${fullUrl}` };
  }
  if (!u.hostname.endsWith('kosis.kr')) {
    return { error: `KOSIS 도메인이 아닙니다: ${u.hostname}` };
  }

  // 쿼리를 raw로 재조립 (URLSearchParams가 '='와 '+'를 망가뜨리지 않도록)
  const pairs = u.search.replace(/^\?/, '').split('&').filter(Boolean);
  const rebuilt = pairs
    .filter((p) => !p.startsWith('apiKey='))
    .concat([`apiKey=${KOSIS_KEY}`]);
  const finalUrl = `${u.origin}${u.pathname}?${rebuilt.join('&')}`;

  return fetchAndParse(finalUrl, 'KOSIS');
}

async function callKosis(service, params) {
  if (!KOSIS_KEY) return { error: 'KOSIS_KEY 환경변수가 서버에 설정되어 있지 않습니다.' };
  const qs = buildQuery(
    { method: 'getList', format: 'json', jsonVD: 'Y', apiKey: KOSIS_KEY, ...params },
    KOSIS_RAW_PARAMS
  );
  return fetchAndParse(`https://kosis.kr/openapi/${service}?${qs}`, 'KOSIS');
}

// ===========================================================================
// V-World (디지털트윈국토) — api.vworld.kr
// ---------------------------------------------------------------------------
// 인증키 파라미터명: key.  추가로 domain 파라미터가 필요.
// [치명적 함정] V-World 인증키는 '발급 시 등록한 서비스 URL(도메인)'에 묶여 있음.
//   → 서버를 배포한 도메인을 V-World 인증키 관리에 등록해두지 않으면 거부됨.
// ===========================================================================
const VWORLD_SERVICES = {
  search: '장소/주소/지번 검색 (service=search&request=search)',
  address: '지오코딩: 주소 → 좌표 (service=address&request=getcoord)',
  data: '공간정보 속성 조회 (service=data&request=GetFeature&data=레이어ID)',
};

async function callVworld(endpointPath, params) {
  if (!VWORLD_KEY) return { error: 'VWORLD_KEY 환경변수가 서버에 설정되어 있지 않습니다.' };

  const merged = { ...params, key: VWORLD_KEY, format: params.format || 'json' };
  if (VWORLD_DOMAIN) merged.domain = VWORLD_DOMAIN;

  const path = endpointPath.replace(/^\//, '');
  const result = await fetchAndParse(`https://api.vworld.kr/req/${path}?${buildQuery(merged)}`, 'V-World');

  // V-World 고유 에러 형태 해설
  const status = result?.data?.response?.status;
  if (status && status !== 'OK') {
    const errText = JSON.stringify(result.data.response.error ?? {});
    return {
      error: 'V-World가 오류를 반환했습니다.',
      status,
      detail: errText,
      hint:
        'INVALID_KEY / 도메인 불일치가 가장 흔한 원인입니다. ' +
        'vworld.kr → 오픈API → 인증키 관리에서, 이 서버가 배포된 도메인이 등록되어 있는지 확인하세요. ' +
        `현재 서버가 보내는 domain 값: ${VWORLD_DOMAIN || '(미설정)'}`,
      requestUrl: result.requestUrl,
    };
  }
  return result;
}

// ===========================================================================
// 에너지마켓플레이스 / 전력데이터 개방포털 — bigdata.kepco.co.kr
// ---------------------------------------------------------------------------
// data.go.kr에는 'LINK' 유형으로만 등록되어 있어, 실제 명세는 포털의
// 'Open-API 사용 매뉴얼.pptx'에만 있음 → 엔드포인트/파라미터를 검증하지 못했음.
// 따라서 키 파라미터명(기본 apiKey)까지 바꿀 수 있게 열어둠.
// ===========================================================================
async function callKepco(fullUrl, params, keyParamName = 'apiKey') {
  if (!KEPCO_KEY) return { error: 'KEPCO_KEY 환경변수가 서버에 설정되어 있지 않습니다.' };

  let u;
  try {
    u = new URL(fullUrl);
  } catch {
    return { error: `올바른 URL이 아닙니다: ${fullUrl}` };
  }
  if (!u.hostname.endsWith('kepco.co.kr')) {
    return { error: `한전 개방포털 도메인이 아닙니다: ${u.hostname}` };
  }

  const merged = { returnType: 'json', ...params, [keyParamName]: KEPCO_KEY };
  return fetchAndParse(`${u.origin}${u.pathname}?${buildQuery(merged)}`, 'KEPCO');
}

// ===========================================================================
// 공통 fetch + XML/JSON 자동 파싱
// ===========================================================================
async function fetchAndParse(url, providerLabel) {
  const safeUrl = maskKeys(url);
  let res, rawText;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json, application/xml;q=0.9' } });
    rawText = await res.text();
  } catch (err) {
    return { provider: providerLabel, error: `네트워크 오류: ${err.message}`, requestUrl: safeUrl };
  }

  let parsed, format;
  try {
    parsed = JSON.parse(rawText);
    format = 'json';
  } catch {
    try {
      parsed = xmlParser.parse(rawText);
      format = 'xml';
    } catch {
      return {
        provider: providerLabel,
        error: 'JSON도 XML도 아닌 응답입니다.',
        httpStatus: res.status,
        raw: maskKeys(rawText.slice(0, 1500)),
        requestUrl: safeUrl,
      };
    }
  }

  if (!res.ok) {
    return { provider: providerLabel, error: `HTTP ${res.status}`, format, body: parsed, requestUrl: safeUrl };
  }

  // KOSIS는 오류를 { err: '20', errMsg: '...' } 형태로 200 OK와 함께 내려줌
  if (parsed && !Array.isArray(parsed) && parsed.err) {
    return { provider: providerLabel, error: `KOSIS 오류 ${parsed.err}`, errMsg: parsed.errMsg, requestUrl: safeUrl };
  }

  return { provider: providerLabel, format, requestUrl: safeUrl, data: parsed };
}

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

// ===========================================================================
// 공공데이터포털(data.go.kr) 관련
// ===========================================================================
//
// [국회 API와의 결정적 차이]
// 열린국회정보는 "하나의 사이트 = 하나의 API 묶음"이라 엔드포인트를 코드에 박아둘 수 있음.
// 반면 공공데이터포털은 수만 개 기관의 서로 다른 API를 모아둔 '포털'일 뿐이며,
//   - API마다 URL이 완전히 다르고
//   - API마다 '활용신청'을 따로 해서 승인받아야 하며
//   - 인증키는 계정당 1개를 모든 승인된 API에 공용으로 사용
// 따라서 특정 API를 미리 코드에 박을 수 없고, '범용 호출기' 형태가 유일하게 올바른 설계임.
//
// [응답 형식]
// 대부분 XML이 기본. type=json 또는 _type=json 또는 dataType=JSON 등 파라미터명이 API마다 다름.
// → XML/JSON 자동 감지 후 항상 JSON으로 변환해서 반환한다.

const DATA_GO_KR_ERROR_HINTS = {
  '01': 'APPLICATION_ERROR - 제공기관 서비스 내부 오류',
  '10': 'INVALID_REQUEST_PARAMETER_ERROR - 요청 파라미터가 잘못됨',
  '12': 'NO_OPENAPI_SERVICE_ERROR - 해당 오픈API가 없거나 폐기됨. endpoint_url을 다시 확인하세요.',
  '20': 'SERVICE_ACCESS_DENIED_ERROR - 접근 거부. 해당 API에 대해 활용신청/승인이 되어 있는지 확인하세요.',
  '22': 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR - 일일 트래픽 한도 초과 (개발계정 기본 1,000건/일)',
  '30': 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR - 인증키 미등록. (a) 해당 API에 활용신청을 했는지, (b) 승인 직후라면 반영까지 최대 1시간가량 걸리는 점을 확인하세요.',
  '31': 'DEADLINE_HAS_EXPIRED_ERROR - 활용기간 만료',
  '32': 'UNREGISTERED_IP_ERROR - 등록되지 않은 IP. 일부 API는 국내 IP만 허용하므로 해외 리전 서버에서 차단될 수 있습니다.',
  '99': 'UNKNOWN_ERROR - 알 수 없는 오류',
};

const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: true, trimValues: true });

/**
 * 공공데이터포털 범용 호출 함수.
 * serviceKey는 URLSearchParams가 자동 인코딩하므로 반드시 '디코딩(Decoding) 일반 인증키'를 넣어야 한다.
 * (인코딩 키를 넣으면 이중 인코딩되어 SERVICE_KEY_IS_NOT_REGISTERED_ERROR 발생)
 */
async function callDataGoKr(endpointUrl, params = {}) {
  if (!DATA_GO_KR_KEY) {
    return { error: 'DATA_GO_KR_KEY 환경변수가 서버에 설정되어 있지 않습니다.' };
  }

  let url;
  try {
    url = new URL(endpointUrl);
  } catch {
    return { error: `endpoint_url이 올바른 URL 형식이 아닙니다: ${endpointUrl}` };
  }

  url.searchParams.set('serviceKey', DATA_GO_KR_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  // 인증키가 로그/응답에 노출되지 않도록 마스킹한 URL을 따로 만들어 둔다
  const safeUrl = url.toString().replace(DATA_GO_KR_KEY, '***SERVICE_KEY***');

  let res, rawText;
  try {
    res = await fetch(url.toString(), { headers: { Accept: 'application/json, application/xml;q=0.9' } });
    rawText = await res.text();
  } catch (err) {
    return { error: `네트워크 오류: ${err.message}`, requestUrl: safeUrl };
  }

  // JSON 우선 시도 → 실패하면 XML 파싱
  let parsed = null;
  let format = null;
  try {
    parsed = JSON.parse(rawText);
    format = 'json';
  } catch {
    try {
      parsed = xmlParser.parse(rawText);
      format = 'xml';
    } catch {
      return {
        error: 'JSON도 XML도 아닌 응답을 받았습니다.',
        httpStatus: res.status,
        raw: rawText.slice(0, 1500),
        requestUrl: safeUrl,
      };
    }
  }

  // 표준 응답 구조에서 결과코드 추출 시도 (구조가 API마다 조금씩 다름)
  const header = parsed?.response?.header ?? parsed?.OpenAPI_ServiceResponse?.cmmMsgHeader ?? null;
  const resultCode = header?.resultCode ?? header?.returnReasonCode ?? null;

  if (resultCode != null && String(resultCode) !== '00' && String(resultCode) !== '0') {
    const code = String(resultCode).padStart(2, '0');
    return {
      error: '공공데이터포털이 오류를 반환했습니다.',
      resultCode: code,
      resultMsg: header?.resultMsg ?? header?.returnAuthMsg ?? null,
      hint: DATA_GO_KR_ERROR_HINTS[code] ?? '알려진 오류코드가 아닙니다.',
      requestUrl: safeUrl,
    };
  }

  if (!res.ok) {
    return { error: `HTTP ${res.status}`, format, body: parsed, requestUrl: safeUrl };
  }

  return { format, requestUrl: safeUrl, data: parsed };
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

  // -------------------------------------------------------------------------
  // 공공데이터포털(data.go.kr) 도구
  // -------------------------------------------------------------------------

  server.registerTool(
    'datago_howto',
    {
      description:
        '공공데이터포털(data.go.kr) 도구를 쓰기 전에 반드시 먼저 호출하세요. 공공데이터포털은 단일 API가 아니라 ' +
        '수많은 기관의 서로 다른 API를 모아둔 포털이므로, 사용자가 어떤 API를 활용신청했는지 알아야 호출할 수 있습니다. ' +
        '이 도구는 엔드포인트 URL을 어디서 찾는지, 어떤 함정이 있는지 설명합니다.',
      inputSchema: {},
    },
    async () =>
      textResult({
        핵심: '공공데이터포털은 API마다 URL이 다르고, API마다 활용신청+승인이 별도로 필요합니다. 인증키는 계정당 1개를 공용으로 씁니다.',
        엔드포인트_URL_찾는법: [
          '1. data.go.kr 로그인 → 마이페이지 → 데이터활용 → Open API → 활용신청 현황',
          '2. 승인된 API를 클릭 → 상세기능(오퍼레이션) 목록이 나옴',
          '3. 각 상세기능의 "요청주소(Call Back URL)"를 복사 → 이것이 endpoint_url',
          '   예시 형태: https://apis.data.go.kr/{기관코드}/{서비스명}/{오퍼레이션명}',
        ],
        주의사항: [
          '인증키는 반드시 "디코딩(Decoding) 일반 인증키"를 서버 환경변수에 넣어야 함. 인코딩 키를 넣으면 이중 인코딩되어 30번 오류 발생.',
          '활용신청 승인 직후에는 키 반영까지 최대 1시간가량 걸릴 수 있음 (30번 오류가 뜨면 잠시 후 재시도).',
          '개발계정 기본 트래픽은 하루 1,000건.',
          '일부 API는 국내 IP만 허용 → 해외 리전 서버에 배포한 경우 32번(UNREGISTERED_IP) 오류가 날 수 있음.',
          'JSON 요청 파라미터명이 API마다 제각각(type / _type / dataType / resultType). 안 되면 XML로 받아도 이 서버가 JSON으로 변환해 줌.',
        ],
        오류코드표: DATA_GO_KR_ERROR_HINTS,
      })
  );

  server.registerTool(
    'call_data_go_kr',
    {
      description:
        '공공데이터포털(data.go.kr)의 임의 Open API를 호출하는 범용 도구입니다. serviceKey는 서버가 자동으로 붙이므로 ' +
        'params에 넣지 마세요. 응답이 XML이어도 자동으로 JSON으로 변환해 반환합니다. ' +
        'endpoint_url을 모르면 datago_howto를 먼저 호출해 찾는 방법을 안내하세요.',
      inputSchema: {
        endpoint_url: z
          .string()
          .describe(
            "쿼리스트링을 뺀 전체 요청주소. 예: 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst'"
          ),
        params: z
          .record(z.string())
          .optional()
          .describe(
            "serviceKey를 제외한 요청 파라미터. 페이징은 보통 pageNo/numOfRows. JSON 요청은 보통 {'type':'json'} 또는 {'dataType':'JSON'}"
          ),
      },
    },
    async ({ endpoint_url, params }) => textResult(await callDataGoKr(endpoint_url, params || {}))
  );

  server.registerTool(
    'call_odcloud',
    {
      description:
        '공공데이터포털 중 api.odcloud.kr 계열(파일데이터를 API화한 "표준데이터셋" 등)을 호출합니다. ' +
        '이 계열은 페이징 파라미터가 pageNo/numOfRows가 아니라 page/perPage이고, 응답이 항상 JSON입니다.',
      inputSchema: {
        endpoint_url: z.string().describe("예: 'https://api.odcloud.kr/api/15012005/v1/uddi:...'"),
        page: z.number().optional().default(1),
        per_page: z.number().optional().default(10),
        params: z.record(z.string()).optional().describe('추가 검색조건 (cond[필드명::EQ] 형태 등)'),
      },
    },
    async ({ endpoint_url, page, per_page, params }) =>
      textResult(await callDataGoKr(endpoint_url, { page, perPage: per_page, ...(params || {}) }))
  );

  // -------------------------------------------------------------------------
  // KOSIS (국가통계포털)
  // -------------------------------------------------------------------------
  server.registerTool(
    'kosis_call_url',
    {
      description:
        '[KOSIS 권장 방식] KOSIS 사이트에서 생성한 요청 URL을 그대로 넣어 호출합니다. ' +
        'KOSIS 공유서비스 → 서비스이용 → 통계자료 → 통계표선택 에서 URL을 생성해 복사하세요. ' +
        'URL 안의 apiKey는 비어있거나 남의 키여도 서버가 자기 키로 교체합니다. ' +
        "인증키의 '='와 itmId의 '+'가 깨지지 않도록 raw로 전송합니다.",
      inputSchema: {
        full_url: z.string().describe('kosis.kr/openapi/... 로 시작하는 전체 요청 URL'),
      },
    },
    async ({ full_url }) => textResult(await callKosisUrl(full_url))
  );

  server.registerTool(
    'kosis_call',
    {
      description:
        'KOSIS 오픈API를 서비스명+파라미터로 직접 호출합니다. 통계표를 아직 특정하지 못했으면 ' +
        "service='statisticsList.do' 로 목록을 먼저 탐색하거나 service='statisticsSearch.do' 로 검색하세요. " +
        "특정 통계표 자료는 service='Param/statisticsParameterData.do' + orgId + tblId 조합을 씁니다.",
      inputSchema: {
        service: z
          .string()
          .describe(`서비스명. 가능값: ${Object.keys(KOSIS_SERVICES).join(', ')}`),
        params: z
          .record(z.string())
          .optional()
          .describe(
            "apiKey/format/jsonVD/method는 자동으로 붙습니다. 예: {'orgId':'101','tblId':'DT_1B41','objL1':'ALL','itmId':'T1+','prdSe':'Y','newEstPrdCnt':'3'}"
          ),
      },
    },
    async ({ service, params }) => textResult(await callKosis(service, params || {}))
  );

  // -------------------------------------------------------------------------
  // V-World (디지털트윈국토)
  // -------------------------------------------------------------------------
  server.registerTool(
    'vworld_call',
    {
      description:
        'V-World(브이월드) 오픈API를 호출합니다. key와 domain은 서버가 자동으로 붙입니다. ' +
        '주소→좌표 변환, 지번 검색, 연속지적도·용도지역지구 등 공간정보 속성 조회에 사용합니다. ' +
        `주요 endpoint: ${Object.entries(VWORLD_SERVICES).map(([k, v]) => `${k}(${v})`).join(' / ')}`,
      inputSchema: {
        endpoint: z.string().describe("req/ 다음 경로. 예: 'search', 'address', 'data'"),
        params: z
          .record(z.string())
          .optional()
          .describe(
            "예(지오코딩): {'service':'address','request':'getcoord','type':'PARCEL','address':'강원특별자치도 원주시 ...'}"
          ),
      },
    },
    async ({ endpoint, params }) => textResult(await callVworld(endpoint, params || {}))
  );

  // -------------------------------------------------------------------------
  // 에너지마켓플레이스 (전력데이터 개방포털)
  // -------------------------------------------------------------------------
  server.registerTool(
    'kepco_call',
    {
      description:
        '한전 전력데이터 개방포털(bigdata.kepco.co.kr) Open API를 호출합니다. ' +
        '⚠️ 이 포털의 명세는 공개 웹에 없고 포털 내부 매뉴얼(pptx)에만 있어, 엔드포인트와 파라미터명이 ' +
        '검증되지 않았습니다. 포털에서 확인한 요청주소를 full_url로 정확히 넣어주세요. ' +
        "인증키 파라미터명이 apiKey가 아니면 key_param_name으로 바꿀 수 있습니다.",
      inputSchema: {
        full_url: z
          .string()
          .describe("bigdata.kepco.co.kr 로 시작하는 요청주소 (쿼리스트링 제외). 예: 'https://bigdata.kepco.co.kr/openapi/v1/...'"),
        params: z.record(z.string()).optional().describe("예: {'year':'2025','month':'01','metroCd':'42'}"),
        key_param_name: z.string().optional().default('apiKey').describe('인증키 파라미터명 (기본 apiKey)'),
      },
    },
    async ({ full_url, params, key_param_name }) =>
      textResult(await callKepco(full_url, params || {}, key_param_name))
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
