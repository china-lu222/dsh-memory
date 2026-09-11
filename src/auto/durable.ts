/**
 * Auto Long-Term Memory — durable 事件归属（阶段 2/3）。
 *
 * auto 域的 durable 事件分两类：
 *  - 语义留痕（writeDomainAudit）：memory.auto.* 前缀，已被 worker 默认消费者集
 *    memory.* 前缀 ack（见 src/worker/handlers.ts），无需新增消费者；
 *  - 任务事件（enqueueEvent，阶段 3）：auto.learn 携带完整 AutoLearnRequest，
 *    由 worker 默认消费者集的 auto.learn 处理（后台执行 autoLearn）。
 * 成功写入沿用 repository 的 memory.create，冲突/隔离沿用 conflict.open /
 * memory.quarantine（各自模块自带的 conflict.* / memory.* 前缀覆盖）。
 * 此处集中定义 service/task 实际发出的事件类型常量。
 */

export const AUTO_ACTIONS = {
  /** 敏感拦截（只留 audit，不落 memory store）。 */
  sensitive: "memory.auto.sensitive",
} as const;

export type AutoAction = (typeof AUTO_ACTIONS)[keyof typeof AUTO_ACTIONS];

/** auto 域 durable 任务事件类型（worker 消费，见 src/worker/handlers.ts）。 */
export const AUTO_TASKS = {
  /** 自动学习任务：payload = AutoLearnRequest（阶段 3 task.ts 提交）。 */
  learn: "auto.learn",
  /**
   * 任务边界经验沉淀：payload = TaskExperienceRequest（R8.1 目标 2）。
   * 抽取与校验已在边界完成，worker 只调用 persistTaskExperience 落库。
   */
  taskExperience: "auto.task-experience",
} as const;

export type AutoTaskType = (typeof AUTO_TASKS)[keyof typeof AUTO_TASKS];
