// 兼容层：WP-03 把明细页实现迁移到 features/transactions 后，
// 此处仅转发导出，保证既有 import 路径（App、单元测试）继续可用。
export { TransactionsPage } from "../features/transactions/TransactionsPage";
