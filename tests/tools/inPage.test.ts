/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import type {ToolGroup} from '../../src/tools/inPage.js';
import {executeInPageTool, listInPageTools} from '../../src/tools/inPage.js';
import {withMcpContext} from '../utils.js';

describe('inPage', () => {
  describe('list_in_page_tools', () => {
    it('lists tools', async () => {
      await withMcpContext(async (response, context) => {
        const page = await context.newPage();
        const toolGroup: ToolGroup = {
          name: 'test-group',
          description: 'test description',
          tools: [
            {
              name: 'test-tool',
              description: 'test tool description',
              inputSchema: {
                type: 'object',
                properties: {
                  arg: {type: 'string'},
                },
              },
              execute: () => 'result',
            },
          ],
        };

        const evaluateStub = sinon.stub(page.pptrPage, 'evaluate');
        evaluateStub.resolves(toolGroup);
        context.setInPageTools(toolGroup);

        await listInPageTools.handler({params: {}, page}, response, context);

        const result = await response.handle('list_in_page_tools', context);
        assert.ok('inPageTools' in result.structuredContent);
        assert.deepEqual(
          (result.structuredContent as {inPageTools: ToolGroup}).inPageTools,
          toolGroup,
        );
        assert.deepEqual(context.getInPageTools(), toolGroup);
      });
    });

    it('handles no tools', async () => {
      await withMcpContext(async (response, context) => {
        const page = await context.newPage();
        const evaluateStub = sinon.stub(page.pptrPage, 'evaluate');
        evaluateStub.resolves(undefined);

        await listInPageTools.handler({params: {}, page}, response, context);

        const result = await response.handle('list_in_page_tools', context);
        assert.ok('inPageTools' in result.structuredContent);
        assert.strictEqual(
          (result.structuredContent as {inPageTools: undefined}).inPageTools,
          undefined,
        );
        assert.strictEqual(context.getInPageTools(), undefined);
      });
    });
  });

  describe('execute_in_page_tool', () => {
    it('executes a tool', async () => {
      await withMcpContext(async (response, context) => {
        const page = await context.newPage();
        const toolGroup: ToolGroup = {
          name: 'test-group',
          description: 'test description',
          tools: [
            {
              name: 'test-tool',
              description: 'test tool description',
              inputSchema: {
                type: 'object',
                properties: {
                  arg: {type: 'string'},
                },
              },
              execute: () => 'result',
            },
          ],
        };

        context.setInPageTools(toolGroup);

        const evaluateStub = sinon.stub(page.pptrPage, 'evaluate');
        evaluateStub.resolves({result: 'result', stashed: 0});

        await executeInPageTool.handler(
          {
            params: {
              toolName: 'test-tool',
              params: {arg: 'value'},
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        assert.strictEqual(response.responseLines[0], 'result');
      });
    });

    it('throws if tool not found in list', async () => {
      await withMcpContext(async (response, context) => {
        const page = await context.newPage();
        const toolGroup: ToolGroup = {
          name: 'test-group',
          description: 'test description',
          tools: [],
        };

        const evaluateStub = sinon.stub(page.pptrPage, 'evaluate');
        evaluateStub.resolves(toolGroup);
        context.setInPageTools(toolGroup);

        await assert.rejects(
          async () => {
            await executeInPageTool.handler(
              {
                params: {
                  toolName: 'missing-tool',
                  params: {},
                },
                page: context.getSelectedMcpPage(),
              },
              response,
              context,
            );
          },
          {message: /Tool missing-tool not found/},
        );
      });
    });

    it('throws if parameters are invalid', async () => {
      await withMcpContext(async (response, context) => {
        const page = await context.newPage();
        const toolGroup: ToolGroup = {
          name: 'test-group',
          description: 'test description',
          tools: [
            {
              name: 'test-tool',
              description: 'test tool description',
              inputSchema: {
                type: 'object',
                properties: {
                  arg: {type: 'string'},
                },
                required: ['arg'],
              },
              execute: () => 'result',
            },
          ],
        };

        context.setInPageTools(toolGroup);

        const evaluateStub = sinon.stub(page.pptrPage, 'evaluate');
        evaluateStub.resolves();

        await assert.rejects(
          async () => {
            await executeInPageTool.handler(
              {
                params: {
                  toolName: 'test-tool',
                  params: {}, // Missing required 'arg'
                },
                page: context.getSelectedMcpPage(),
              },
              response,
              context,
            );
          },
          {message: /Invalid parameters for tool test-tool/},
        );
      });
    });

    it('handles JSON result', async () => {
      await withMcpContext(async (response, context) => {
        const page = await context.newPage();
        const toolGroup: ToolGroup = {
          name: 'test-group',
          description: 'test description',
          tools: [
            {
              name: 'test-tool',
              description: 'test tool description',
              inputSchema: {},
              execute: () => ({foo: 'bar'}),
            },
          ],
        };

        context.setInPageTools(toolGroup);

        const evaluateStub = sinon.stub(page.pptrPage, 'evaluate');
        evaluateStub.resolves({result: {foo: 'bar'}, stashed: 0});

        await executeInPageTool.handler(
          {
            params: {
              toolName: 'test-tool',
              params: {},
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        assert.strictEqual(
          response.responseLines[0],
          JSON.stringify({foo: 'bar'}, null, 2),
        );
      });
    });
  });
});
