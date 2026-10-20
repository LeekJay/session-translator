import { expect, test } from 'claude-code/testing'
import { goalConditionContext, isGoalCondition } from './goal'

test('目标条件是参数原文，查询和清除词不算条件', {}, async () => {
  expect(isGoalCondition('修好登录问题')).toBe(true)
  expect(isGoalCondition('  fix login  ')).toBe(true)
  expect(isGoalCondition('')).toBe(false)
  expect(isGoalCondition('   ')).toBe(false)
  expect(isGoalCondition('clear')).toBe(false)
  expect(isGoalCondition('STOP')).toBe(false)
  expect(isGoalCondition('reset')).toBe(false)
})

test('隐藏上下文点名这是 /goal 条件的英文译文', {}, async () => {
  const text = goalConditionContext('Fix the login problem')
  expect(text).toContain('English translation')
  expect(text).toContain('/goal')
  expect(text).toContain('Fix the login problem')
})
