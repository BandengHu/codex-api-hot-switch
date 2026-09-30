import type { JsonRecord } from './types.js';

export const WEB_SEARCH_TOOL_PARAMETERS: JsonRecord = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'The web search query.',
    },
    search_context_size: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Requested search depth when available.',
    },
    user_location: {
      type: 'object',
      description: 'Optional user location hints from the original request.',
      additionalProperties: true,
    },
  },
  required: ['query'],
  additionalProperties: true,
};

export const FILE_SEARCH_TOOL_PARAMETERS: JsonRecord = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'The file search query.',
    },
    path_glob: {
      type: 'string',
      description: 'Optional glob-style path filter within configured roots.',
    },
    max_results: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Maximum number of matching file search results to return.',
    },
    max_num_results: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'OpenAI-compatible maximum number of file search results to return.',
    },
    vector_store_ids: {
      type: 'array',
      items: {
        type: 'string',
      },
      description: 'Optional OpenAI-compatible vector store ids. In relay-emulated mode these map to configured source names.',
    },
    filters: {
      type: 'object',
      description: 'Optional OpenAI-compatible metadata filter tree using eq/ne/gt/gte/lt/lte/in/nin and and/or.',
      additionalProperties: true,
    },
    ranking_options: {
      type: 'object',
      description: 'Optional OpenAI-compatible ranking options, including ranker, score_threshold, and hybrid_search weights.',
      additionalProperties: true,
    },
    include_content: {
      type: 'boolean',
      description: 'Whether to include retrieved chunk text in results.',
    },
  },
  required: ['query'],
  additionalProperties: true,
};

export const TOOL_SEARCH_TOOL_PARAMETERS: JsonRecord = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Tool discovery query.',
    },
    goal: {
      type: 'string',
      description: 'Optional task goal for deferred tool discovery.',
    },
  },
  additionalProperties: true,
};

export const IMAGE_GENERATION_TOOL_PARAMETERS: JsonRecord = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'Image generation prompt.',
    },
    size: {
      type: 'string',
      description: 'Optional output size such as 1024x1024.',
    },
    quality: {
      type: 'string',
      description: 'Optional image quality value supported by the configured provider.',
    },
    background: {
      type: 'string',
      description: 'Optional background mode supported by the configured provider.',
    },
    output_format: {
      type: 'string',
      description: 'Optional output format such as png, jpeg, or webp.',
    },
    n: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'Number of images to generate.',
    },
  },
  required: ['prompt'],
  additionalProperties: true,
};

export const CODE_INTERPRETER_TOOL_PARAMETERS: JsonRecord = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description: 'Code to execute in the configured interpreter sandbox.',
    },
    language: {
      type: 'string',
      description: 'Requested language such as python or javascript.',
    },
    container: {
      description: 'Container selector or sandbox configuration supplied by the host.',
      oneOf: [
        { type: 'string' },
        {
          type: 'object',
          additionalProperties: true,
        },
      ],
    },
    files: {
      type: 'array',
      description: 'Optional files made available to the configured interpreter sandbox.',
      items: {
        type: 'object',
        properties: {
          file_id: { type: 'string' },
          filename: { type: 'string' },
          content: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
  },
  required: ['code'],
  additionalProperties: true,
};

export const COMPUTER_TOOL_PARAMETERS: JsonRecord = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      description: 'Computer actions to execute through the explicitly configured host adapter.',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['click', 'double_click', 'scroll', 'type', 'wait', 'keypress', 'drag', 'move', 'screenshot'],
          },
          x: { type: 'number' },
          y: { type: 'number' },
          button: { type: 'string' },
          scroll_x: { type: 'number' },
          scroll_y: { type: 'number' },
          text: { type: 'string' },
          ms: { type: 'integer', minimum: 0 },
          keys: {
            type: 'array',
            items: { type: 'string' },
          },
          path: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                x: { type: 'number' },
                y: { type: 'number' },
              },
              required: ['x', 'y'],
              additionalProperties: true,
            },
          },
        },
        required: ['type'],
        additionalProperties: true,
      },
    },
    display: {
      type: 'object',
      description: 'Optional display metadata for the host-controlled computer environment.',
      properties: {
        width: { type: 'number' },
        height: { type: 'number' },
        environment: { type: 'string' },
      },
      additionalProperties: true,
    },
  },
  required: ['actions'],
  additionalProperties: true,
};

export const EMPTY_UNSAFE_TOOL_PARAMETERS: JsonRecord = {
  type: 'object',
  properties: {},
  additionalProperties: true,
};
