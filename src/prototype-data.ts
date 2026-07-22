export type Version = 'V3.6' | 'V3.5'

export type Requirement = {
  id: string
  title: string
  version: string
  updated: string
  author: string
  status: '待分析' | '分析完成' | '分析中'
  intro: string
  sections: string[]
  findings: { tone: 'red' | 'orange' | 'blue'; title: string; text: string; tag: string }[]
}

const paymentRequirement: Requirement = {
  id: 'REQ-2026-021',
  title: '支付模块重构需求',
  version: 'V2.3',
  updated: '2026-07-20',
  author: '张倩',
  status: '分析完成',
  intro: '统一支付、退款及回调处理链路，降低渠道接入成本，并提升异常场景下的数据一致性。',
  sections: ['项目背景', '业务目标', '退款处理规则', '验收标准'],
  findings: [
    { tone: 'red', title: '退款并发规则描述不完整', text: '需求未明确同一订单多次退款请求的幂等处理与金额上限。', tag: '需要确认' },
    { tone: 'orange', title: '权限边界存在潜在缺口', text: '财务角色与客服角色对退款详情的字段可见范围未定义。', tag: '高风险' },
    { tone: 'blue', title: '关联到历史业务规则', text: '支付网关规范 V4.2 要求所有退款请求携带唯一幂等键。', tag: '有依据' },
  ],
}

export const requirementsByVersion: Record<Version, Requirement[]> = {
  'V3.6': [
    paymentRequirement,
    {
      id: 'REQ-2026-022', title: '会员积分体系升级', version: 'V1.6', updated: '2026-07-19', author: '赵敏', status: '待分析',
      intro: '升级积分获取、冻结、过期和抵扣规则，为不同会员等级提供差异化权益。', sections: ['需求背景', '积分生命周期', '等级权益', '异常处理'],
      findings: [{ tone: 'orange', title: '过期规则待确认', text: '冻结积分转为可用积分后的过期计时规则尚未定义。', tag: '待确认' }],
    },
    {
      id: 'REQ-2026-023', title: '订单导出体验优化', version: 'V1.2', updated: '2026-07-18', author: '陈晨', status: '待分析',
      intro: '改善订单导出等待体验并提供导出任务的可追踪状态。', sections: ['范围说明', '导出任务', '异常提示', '验收标准'],
      findings: [{ tone: 'blue', title: '异步任务建议', text: '建议导出结果提供有效期与下载审计记录。', tag: '有依据' }],
    },
  ],
  'V3.5': [
    {
      ...paymentRequirement,
      id: 'REQ-2026-014', version: 'V2.1', updated: '2026-06-12',
      intro: '统一支付和退款处理链路，并补齐渠道回调的基础状态管理。',
      findings: [{ tone: 'orange', title: '退款状态缺少超时定义', text: '当前版本未定义渠道回调超时后的人工处理入口。', tag: '待确认' }],
    },
    {
      id: 'REQ-2026-015', title: '营销券核销优化', version: 'V1.4', updated: '2026-06-10', author: '王敏', status: '分析完成',
      intro: '优化营销券叠加、核销失败和订单取消后的权益回滚能力。', sections: ['使用范围', '核销顺序', '回滚机制', '验收标准'],
      findings: [{ tone: 'blue', title: '核销顺序已有规范', text: '营销券规范 V3.0 已定义同类优惠券按到期时间排序。', tag: '有依据' }],
    },
  ],
}

export type KnowledgeDirectory = {
  id: string
  name: string
  parentId: string | null
}

export type KnowledgeDocument = {
  id: string
  name: string
  parentId: string | null
  version: string
  updated: string
  title: string
  intro: string
  sections: string[]
  content?: string
  assetType?: string
  sourceType?: string
  assetVersionId?: string
  versions?: { id: string; number: number; status: string; createdAt: string }[]
  status?: string
  logicalPath?: string
}

export const knowledgeDirectories: KnowledgeDirectory[] = [
  { id: 'directory-requirements', name: '需求文档', parentId: null },
  { id: 'directory-designs', name: '技术方案', parentId: null },
  { id: 'directory-payment-service', name: '支付服务', parentId: 'directory-designs' },
  { id: 'directory-engineering', name: '研发规范', parentId: null },
  { id: 'directory-testing', name: '测试规范', parentId: null },
]

export const knowledgeDocuments: KnowledgeDocument[] = [
  { id: 'payment-prd', name: '支付模块重构需求.md', parentId: 'directory-requirements', version: 'V2.3', updated: '2 分钟前', title: '支付模块重构需求', intro: '本次重构旨在统一支付、退款及回调处理链路，降低渠道接入成本，并提升异常场景下的数据一致性。', sections: ['项目背景', '业务目标', '功能范围', '退款处理规则', '验收标准'] },
  { id: 'points-prd', name: '会员积分体系升级.md', parentId: 'directory-requirements', version: 'V1.6', updated: '昨天', title: '会员积分体系升级', intro: '升级积分获取、冻结、过期和抵扣规则，为不同会员等级提供差异化权益。', sections: ['需求背景', '积分生命周期', '等级权益', '异常处理', '验收标准'] },
  { id: 'payment-design', name: '支付服务技术方案.md', parentId: 'directory-payment-service', version: 'V1.8', updated: '昨天', title: '支付服务技术方案', intro: '支付服务采用统一网关适配多渠道，通过事件驱动机制完成订单状态同步与最终一致性保障。', sections: ['整体架构', '模块设计', '数据模型', '接口定义', '容灾方案'] },
  { id: 'error-code', name: '接口错误码规范.md', parentId: 'directory-engineering', version: 'V4.2', updated: '刚刚', title: '接口错误码规范', intro: '统一平台接口错误码组成、分类、返回结构及日志记录方式。', sections: ['编码规则', '错误分类', '响应结构', '使用示例', '检查清单'] },
  { id: 'quality-gate', name: '质量门禁规范.md', parentId: 'directory-testing', version: 'V3.1', updated: '5 天前', title: '质量门禁规范', intro: '定义各测试阶段的准入、准出条件以及阻断发布的质量指标。', sections: ['适用范围', '准入条件', '准出条件', '风险豁免', '审计要求'] },
]

export type SettingsDraft = {
  mainModel: string
  temperature: number
  intelligentRouting: boolean
  fallbackEnabled: boolean
  chunkSize: string
  chunkOverlap: string
  vectorRecall: string
  keywordRecall: string
  finalResults: string
  relevanceThreshold: number
  hybridSearch: boolean
  rerankerEnabled: boolean
  rerankerModel: string
  repositoryUrl: string
  defaultBranch: string
  auditEnabled: boolean
  parserVersion: string
  preprocessVersion: string
  chunkMaxSize: string
  headingDepth: string
  embeddingMode: string
  embeddingBaseUrl: string
  embeddingApiKey: string
  embeddingModel: string
  embeddingDimensions: string
  embeddingBatchSize: string
  embeddingTimeoutMs: string
  embeddingRetries: string
}

export const initialSettings: SettingsDraft = {
  mainModel: 'GPT-5.2 · 推荐',
  temperature: 0.2,
  intelligentRouting: true,
  fallbackEnabled: true,
  chunkSize: '400 tokens',
  chunkOverlap: '50 tokens',
  vectorRecall: '40',
  keywordRecall: '40',
  finalResults: '8',
  relevanceThreshold: 0.62,
  hybridSearch: true,
  rerankerEnabled: true,
  rerankerModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  repositoryUrl: 'https://git.example.com/smarthub.git',
  defaultBranch: 'main',
  auditEnabled: true,
  parserVersion: 'markdown-v1',
  preprocessVersion: 'normalize-v1',
  chunkMaxSize: '480',
  headingDepth: '4',
  embeddingMode: 'local',
  embeddingBaseUrl: '',
  embeddingApiKey: '',
  embeddingModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  embeddingDimensions: '384',
  embeddingBatchSize: '32',
  embeddingTimeoutMs: '30000',
  embeddingRetries: '2',
}
