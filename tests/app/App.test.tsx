/**
 * 组件级验证（需求 A01/A07/A10、D11、T13）：
 * 添加节点、局部取消不改原数据、跳过可选景点、保存反馈、阻止导出提示。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/app/App';

describe('应用组件流程', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('空行程显示引导与添加入口（UI-01）', () => {
    render(<App />);
    expect(screen.getByText('省脚力路线卡')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加景点' })).toBeInTheDocument();
  });

  it('添加景点：填写名称后出现在列表（A01）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '添加景点' }));
    await user.type(screen.getByLabelText('名称'), '示例景点甲');
    await user.click(screen.getByRole('button', { name: '添加' }));
    expect(screen.getByText('示例景点甲')).toBeInTheDocument();
    // 自动保存反馈
    expect(screen.getByText('已保存在本机')).toBeInTheDocument();
  });

  it('局部面板取消不修改原行程（A07/T13）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '添加景点' }));
    await user.type(screen.getByLabelText('名称'), '示例景点乙');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await user.click(screen.getByRole('button', { name: '编辑' }));
    const nameInput = screen.getByLabelText('名称');
    await user.clear(nameInput);
    await user.type(nameInput, '被丢弃的名字');
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByText('示例景点乙')).toBeInTheDocument();
    expect(screen.queryByText('被丢弃的名字')).not.toBeInTheDocument();
  });

  it('园内步行大于停留时阻止确认并指出字段（A07）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '添加景点' }));
    await user.type(screen.getByLabelText('名称'), '示例景点丙');
    await user.type(screen.getByLabelText('预计停留（分钟）'), '30');
    await user.type(screen.getByLabelText('园内预计步行（分钟）'), '40');
    await user.click(screen.getByRole('button', { name: '添加' }));
    expect(screen.getByRole('alert').textContent).toContain('园内步行不能大于停留时长');
    expect(screen.queryByText('示例景点丙')).not.toBeInTheDocument();
  });

  it('跳过可选景点：进入已跳过区并可恢复（R07）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '添加景点' }));
    await user.type(screen.getByLabelText('名称'), '可选景点丁');
    await user.click(screen.getByLabelText('可选'));
    await user.click(screen.getByRole('button', { name: '添加' }));

    const card = screen.getByRole('article', { name: '可选景点丁' });
    await user.click(within(card).getByRole('button', { name: '跳过此站' }));
    expect(screen.getByText('已跳过（资料保留）')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '恢复' }));
    expect(screen.getByRole('article', { name: '可选景点丁' })).toBeInTheDocument();
  });

  it('删除整份行程需二次确认；取消不损失内容（A10）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '添加景点' }));
    await user.type(screen.getByLabelText('名称'), '示例景点戊');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await user.click(screen.getByRole('button', { name: '删除整份行程' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByText('示例景点戊')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '删除整份行程' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(screen.queryByText('示例景点戊')).not.toBeInTheDocument();
  });

  it('无有效景点时预览提示无法导出并解释原因（14.8）', async () => {
    const user = userEvent.setup();
    render(<App />);
    // 只有起点终点、无景点 → blocked
    await user.type(screen.getByLabelText('起点'), '示例酒店');
    await user.type(screen.getByLabelText('终点'), '示例车站');
    await user.click(screen.getByRole('button', { name: '大字预览' }));
    // 窄屏（jsdom 下为非宽屏）由吸底操作栏承担导出入口，状态为不可用并解释原因
    expect(screen.getByRole('button', { name: /无法导出/ })).toBeDisabled();
    // 纸面状态行与导出面板提示都解释原因
    expect(screen.getAllByText(/请先完善行程/).length).toBeGreaterThanOrEqual(1);
  });
});
