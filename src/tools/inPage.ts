/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../logger.js';
import {
  zod,
  ajv,
  type JSONSchema7,
  type ElementHandle,
} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  execute: (input: Record<string, unknown>) => unknown;
}

export interface ToolGroup {
  name: string;
  description: string;
  tools: ToolDefinition[];
}

declare global {
  interface Window {
    __dtmcp?: {
      toolGroup?: ToolGroup;
      stashedElements?: Element[];
      executeTool?: (
        toolName: string,
        args: Record<string, unknown>,
      ) => unknown;
    };
  }
}

export const listInPageTools = definePageTool({
  name: 'list_in_page_tools',
  description: `Lists all in-page-tools the page exposes for providing runtime information.
  In-page-tools can be called via the 'execute_in_page_tool()' MCP tool.
  In addition, the in-page-tools are exposed on the page via the 'window.__dtmcp.executeTool(toolName, params)'
  function where they can be called by 'evaluate_script'. This might be helpful when the in-page-tools return
  non-serializable values or when composing the in-page-tools with additional functionality.`,
  annotations: {
    category: ToolCategory.IN_PAGE,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (_request, response, _context) => {
    response.setListInPageTools();
  },
});

export const executeInPageTool = definePageTool({
  name: 'execute_in_page_tool',
  description: `Executes a tool exposed by the page.`,
  annotations: {
    category: ToolCategory.IN_PAGE,
    readOnlyHint: false,
  },
  schema: {
    toolName: zod.string().describe('The name of the tool to execute'),
    params: zod
      .record(zod.string(), zod.unknown())
      .optional()
      .describe('The parameters to pass to the tool'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedMcpPage();
    const toolName = request.params.toolName;
    const params = request.params.params ?? {};

    // Creates array of ElementHandles from the UIDs in the params.
    // We do not replace the uids with the ElementsHandles yet, because
    // the `evaluate` function only turns them into DOM elements if they
    // are passed as non-nested arguments.
    const handles: ElementHandle[] = [];
    for (const value of Object.values(params)) {
      if (
        value instanceof Object &&
        'uid' in value &&
        typeof value.uid === 'string' &&
        Object.keys(value).length === 1
      ) {
        handles.push(await page.getElementByUid(value.uid));
      }
    }

    const toolGroup = context.getInPageTools();
    const tool = toolGroup?.tools.find(t => t.name === toolName);
    if (!tool) {
      throw new Error(`Tool ${toolName} not found`);
    }
    const ajvInstance = new ajv();
    const validate = ajvInstance.compile(tool.inputSchema);
    const valid = validate(params);
    if (!valid) {
      throw new Error(
        `Invalid parameters for tool ${toolName}: ${ajvInstance.errorsText(validate.errors)}`,
      );
    }

    const result = await page.pptrPage.evaluate(
      async (name, args, ...elements) => {
        // Replace the UIDs with DOM elements.
        for (const [key, value] of Object.entries(args)) {
          if (
            value instanceof Object &&
            'uid' in value &&
            typeof value.uid === 'string' &&
            Object.keys(value).length === 1
          ) {
            args[key] = elements.shift();
          }
        }

        if (!window.__dtmcp?.executeTool) {
          throw new Error('No tools found on the page');
        }
        const toolResult = await window.__dtmcp.executeTool(name, args);
        // TODO: remove
        console.log('toolResult', toolResult);

        const stashDOMElement = (el: Element) => {
          if (!window.__dtmcp) {
            window.__dtmcp = {};
          }
          if (window.__dtmcp.stashedElements === undefined) {
            window.__dtmcp.stashedElements = [];
          }
          window.__dtmcp.stashedElements.push(el);
          return {
            stashedId: `stashed-${window.__dtmcp.stashedElements.length - 1}`,
          };
        };

        // Walks the tool result and replaces all DOM elements with uids.
        const stashAllDOMElements = (data: unknown): unknown => {
          // 1. Handle DOM Elements
          if (data instanceof Element) {
            return stashDOMElement(data);
          }

          // 2. Handle Arrays
          if (Array.isArray(data)) {
            return data.map((item: unknown) => stashAllDOMElements(item));
          }

          // 3. Handle Objects
          if (data !== null && typeof data === 'object') {
            const processedObj: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(data)) {
              processedObj[key] = stashAllDOMElements(value);
            }
            return processedObj;
          }

          // 4. Return primitives (strings, numbers, booleans) as-is
          return data;
        };

        const resultWithStashedElements = stashAllDOMElements(toolResult);
        // TODO: remove
        console.log('resultWithStashedElements', resultWithStashedElements);
        return {
          result: resultWithStashedElements,
          stashed: window.__dtmcp?.stashedElements?.length ?? 0,
        };
      },
      toolName,
      params,
      ...handles,
    );

    const elementHandles: ElementHandle[] = [];
    for (let i = 0; i < (result.stashed ?? 0); i++) {
      const elementHandle = await page.pptrPage.evaluateHandle(index => {
        return window.__dtmcp?.stashedElements?.[index] ?? null;
      }, i);
      // TODO: remove
      logger('elementHandle', elementHandle);
      elementHandles.push(elementHandle as ElementHandle);
    }
    const resultWithStashedElements = result.result;

    let isPageSnapshotUpdated = false;
    const stashedToUid = async (index: number) => {
      const backendNodeId = await elementHandles[index].backendNodeId();
      if (!backendNodeId) {
        logger(`No backendNodeId for stashed DOM element with index ${index}`);
        return {uid: `stashed-${index}`};
      }
      let cdpElementId = context.resolveCdpElementId(page, backendNodeId);
      if (!cdpElementId) {
        await context.createTextSnapshot(
          page,
          false,
          undefined,
          elementHandles,
        );
        isPageSnapshotUpdated = true;
        cdpElementId = context.resolveCdpElementId(page, backendNodeId);
      }
      if (!cdpElementId) {
        logger(`Could not get cdpElementId for backend node ${backendNodeId}`);
        return {uid: `stashed-${index}`};
      }
      return {uid: cdpElementId};
    };

    const walkTree = async (node: unknown): Promise<unknown> => {
      if (Array.isArray(node)) {
        return await Promise.all(node.map(async x => await walkTree(x)));
      }
      if (node !== null && typeof node === 'object') {
        if (
          'stashedId' in node &&
          typeof node.stashedId === 'string' &&
          node.stashedId.startsWith('stashed-') &&
          Object.keys(node).length === 1
        ) {
          const index = parseInt(node.stashedId.split('-')[1]);
          return stashedToUid(index);
        }
        const resultObj: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node)) {
          resultObj[key] = await walkTree(value);
        }
        return resultObj;
      }
      return node;
    };

    const resultWithUids = await walkTree(resultWithStashedElements);
    response.appendResponseLine(
      typeof resultWithUids === 'string'
        ? resultWithUids
        : JSON.stringify(resultWithUids, null, 2),
    );
    if (isPageSnapshotUpdated) {
      response.includeSnapshot();
    }
  },
});
