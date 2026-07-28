import React, { useState, useEffect } from 'react';

const defaultNodes = [
  { id: 'start', type: 'start', position: { x: 100, y: 100 }, data: { label: '开始' } },
  { id: 'chat', type: 'chat', position: { x: 300, y: 100 }, data: { label: 'AI 问答' } },
];

const defaultEdges = [
  { id: 'e-start-chat', source: 'start', target: 'chat' },
];

export function WorkflowDesignerApp() {
  const [nodes, setNodes] = useState(defaultNodes);
  const [edges, setEdges] = useState(defaultEdges);
  const [workflowId, setWorkflowId] = useState('wf_001');

  const handleSave = async () => {
    try {
      const definition = { id: workflowId, nodes, edges, config: {} };
      const response = await window.electronAPI.saveWorkflow(definition);
      alert(response.message);
    } catch (error) {
      console.error('Save failed:', error);
    }
  };

  const handleExecute = async () => {
    try {
      const result = await window.electronAPI.executeWorkflow(workflowId);
      console.log('Execution result:', result);
    } catch (error) {
      console.error('Execution error:', error);
    }
  };

  useEffect(() => {
    window.electronAPI.onMessage('workflow:result', (payload) => {
      console.log('Result log:', payload);
    });
  }, []);

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h2>工作流编排器</h2>
      <div style={{ marginBottom: '20px' }}>
        <button onClick={handleSave} style={{ marginRight: '10px' }}>保存工作流</button>
        <button onClick={handleExecute}>执行工作流</button>
      </div>
      <div style={{ 
        border: '1px solid #ccc', 
        height: '400px', 
        position: 'relative',
        backgroundColor: '#f9f9f9'
      }}>
        {nodes.map(node => (
          <div 
            key={node.id} 
            style={{ 
              position: 'absolute', 
              left: `${node.position.x}px`, 
              top: `${node.position.y}px`, 
              padding: '8px', 
              backgroundColor: '#fff', 
              border: '1px solid #999',
              borderRadius: '4px'
            }}
          >
            {node.data.label}
          </div>
        ))}
      </div>
    </div>
  );
}