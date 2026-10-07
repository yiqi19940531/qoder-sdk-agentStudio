import { useEffect, useMemo, useState } from 'react';
import type { AgentConfig, Conversation, ConversationEvent } from '../shared/types';
import { buildAgentFlow, type AgentFlowNode, type FlowStatus } from '../shared/agent-flow';
import { displayStatus, eventLabel, t, type Language } from './i18n';

const stateText: Record<FlowStatus, string> = {
  configured: '已装配', waiting: '等待决策', running: '执行中', done: '已完成', failed: '失败',
};

function actionTitle(event: ConversationEvent, node: AgentFlowNode, language: Language): string {
  if (event.toolName === 'Agent') {
    let description = '';
    try { description = (JSON.parse(event.detail ?? '{}') as { description?: string }).description ?? ''; } catch { /* Older events may have non-JSON details. */ }
    const action = t(language, node.agent.kind === 'subagent' ? '收到主 Agent 委派' : '委派 Sub-Agent');
    return description ? `${action} · ${description}` : action;
  }
  if (event.label === '工具结果' && event.targetAgentId) return t(language, '收到 Sub-Agent 结果');
  if (event.type === 'agent_text') return t(language, '子 Agent 回答');
  return eventLabel(language, event.label ?? event.toolName ?? event.type);
}

export function AgentFlow({ root, children, conversation, mode, language }: {
  root: AgentConfig;
  children: AgentConfig[];
  conversation?: Conversation | null;
  mode: 'assembly' | 'run';
  language: Language;
}) {
  const l = (text: string) => t(language, text);
  const [selectedAgentId, setSelectedAgentId] = useState(root.id);
  const [selectedTurnId, setSelectedTurnId] = useState('');
  useEffect(() => { setSelectedAgentId(root.id); setSelectedTurnId(''); }, [root.id, conversation?.id]);
  const flow = useMemo(() => buildAgentFlow(root, children, conversation ?? undefined, selectedTurnId), [root, children, conversation, selectedTurnId]);
  const selected = flow.nodes.find((item) => item.agent.id === selectedAgentId) ?? flow.nodes[0];
  const rootNode = flow.nodes[0];
  const childNodes = flow.nodes.slice(1);
  const messages = conversation?.messages.filter((item) => item.turnId === flow.turn?.id) ?? [];
  const canvasWidth = Math.max(560, childNodes.length * 230);

  const nodeButton = (node: AgentFlowNode, isRoot: boolean) => <button
    key={node.agent.id}
    type="button"
    className={`flow-node ${isRoot ? 'flow-main' : 'flow-child'} flow-${node.status} ${selected.agent.id === node.agent.id ? 'selected' : ''}`}
    onClick={() => setSelectedAgentId(node.agent.id)}
    aria-pressed={selected.agent.id === node.agent.id}
    aria-label={language === 'en' ? `${node.agent.name}, ${l(stateText[node.status])}, click for details` : `${node.agent.name}，${stateText[node.status]}，点击查看详情`}
  >
    <span className="flow-node-icon">{isRoot ? '◇' : '↳'}</span>
    <span className="flow-node-copy"><small>{isRoot ? l('主 Agent') : 'Sub-Agent'} · {l(stateText[node.status])}</small><strong>{node.agent.name}</strong><em>{mode === 'run' && flow.turn ? (isRoot ? (language === 'en' ? `${node.actions.length} actions` : `${node.actions.length} 条动作`) : (language === 'en' ? `${node.invocations} ${node.invocations === 1 ? 'delegation' : 'delegations'} · ${node.actions.length} actions` : `${node.invocations} 次委派 · ${node.actions.length} 条动作`)) : (language === 'en' ? `${node.agent.tools.length} tools · ${node.agent.mcpServers.length} MCP` : `${node.agent.tools.length} 个工具 · ${node.agent.mcpServers.length} 个 MCP`)}</em></span>
    <span className="flow-node-dot" aria-hidden="true" />
  </button>;

  return <section className={`panel agent-flow-panel ${mode === 'run' ? 'flow-runtime' : ''}`} aria-label={mode === 'run' ? l('运行流程图') : l('Agent 装配图')}>
    <div className="flow-heading">
      <div><span className="flow-kicker">AGENT FLOW</span><h2>{mode === 'run' ? l('运行流程图') : l('Agent 装配图')}</h2><p>{mode === 'run' ? l('连线亮起表示本轮已委派；点击节点查看该 Agent 的动作与结果。') : l('主 Agent 与已装配的 Sub-Agent；点击节点查看各自能力。')}</p></div>
      {mode === 'run' && conversation && <label className="flow-turn-picker">{l('查看轮次')}<select value={selectedTurnId} onChange={(event) => setSelectedTurnId(event.target.value)}><option value="">{l('最新一轮')}</option>{conversation.turns.map((turn, index) => <option value={turn.id} key={turn.id}>{language === 'en' ? `Turn ${index + 1}` : `第 ${index + 1} 轮`} · {new Date(turn.startedAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}</option>)}</select></label>}
    </div>
    <div className="flow-content">
      <div className="flow-scroll"><div className="flow-canvas" style={{ minWidth: canvasWidth }}>
        <div className="flow-root-row">{nodeButton(rootNode, true)}</div>
        {childNodes.length ? <>
          <svg className="flow-lines" viewBox="0 0 1000 106" preserveAspectRatio="none" aria-hidden="true">
            {childNodes.map((node, index) => {
              const x = ((index + .5) / childNodes.length) * 1000;
              return <path key={node.agent.id} className={`flow-edge flow-edge-${node.status} ${node.invocations ? 'invoked' : ''}`} d={`M 500 1 C 500 58, ${x} 48, ${x} 103`} />;
            })}
          </svg>
          <div className="flow-child-row" style={{ gridTemplateColumns: `repeat(${childNodes.length}, minmax(0, 1fr))` }}>{childNodes.map((node) => nodeButton(node, false))}</div>
        </> : <p className="flow-empty">{l('还没有装配 Sub-Agent。可在下方的 Sub-Agent 装配区添加。')}</p>}
      </div></div>
      <aside className="flow-inspector" aria-live="polite">
        <div className="flow-inspector-head"><small>{selected.agent.kind === 'main' ? l('主 Agent') : 'Sub-Agent'} / {mode === 'run' ? l(stateText[selected.status]) : l('装配信息')}</small><h3>{selected.agent.name}</h3><p>{selected.agent.description}</p></div>
        <dl className="flow-properties"><div><dt>{l('模型')}</dt><dd>{selected.agent.model}</dd></div><div><dt>{l('工具')}</dt><dd>{selected.agent.tools.join('、') || l('无')}</dd></div><div><dt>Skills</dt><dd>{selected.agent.skills.join('、') || l('无')}</dd></div><div><dt>MCP</dt><dd>{selected.agent.mcpServers.join('、') || l('无')}</dd></div></dl>
        {mode === 'run' && <>
          {selected.agent.id === root.id && messages.length > 0 && <div className="flow-message-list">{messages.map((message) => <details key={message.id}><summary>{message.role === 'user' ? l('用户任务') : l('主 Agent 回答')}</summary><p>{message.content || l('正在生成…')}</p></details>)}</div>}
          {!!selected.artifacts.length && <div className="flow-artifacts"><h4>{l('本轮产物')}</h4>{selected.artifacts.map((artifact) => <p key={artifact.id}>{artifact.kind === 'image' ? l('图片') : l('视频')} · {displayStatus(language, artifact.status)}{artifact.url && <> · <a href={artifact.url} target="_blank" rel="noreferrer">{l('打开产物')}</a></>}{artifact.error && <span> · {artifact.error}</span>}</p>)}</div>}
          <h4>{l('执行动作')} <span>{selected.actions.length}</span></h4>
          <div className="flow-action-list">{selected.actions.length ? selected.actions.map((event) => <article key={event.id} className={`flow-action flow-action-${event.type}`}><time>{new Date(event.at).toLocaleTimeString(language === 'en' ? 'en-US' : 'zh-CN')}</time><strong>{actionTitle(event, selected, language)}</strong>{event.detail && <details className="flow-action-detail"><summary>{l('查看参数与结果')}</summary><pre>{event.detail}</pre></details>}</article>) : <p className="flow-no-actions">{flow.turn ? l('这一轮没有记录到该 Agent 的动作。') : l('开始运行后，这里会显示每个 Agent 的动作。')}</p>}</div>
        </>}
      </aside>
    </div>
  </section>;
}
