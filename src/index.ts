#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { join, dirname, basename, normalize } from 'path';
import { existsSync, readdirSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

// Check if debug mode is enabled
const DEBUG_MODE: boolean = process.env.DEBUG === 'true';
const GODOT_DEBUG_MODE: boolean = true; // Always use GODOT DEBUG MODE

const execAsync = promisify(exec);

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Interface representing a running Godot process
 */
interface GodotProcess {
  process: any;
  output: string[];
  errors: string[];
}

/**
 * Interface for server configuration
 */
interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  godotDebugMode?: boolean;
  strictPathValidation?: boolean; // New option to control path validation behavior
  maxOutputBufferSize?: number; // Maximum number of lines to store in output/error buffers
}

/**
 * Interface for operation parameters
 */
interface OperationParams {
  [key: string]: any;
}

/**
 * Main server class for the Godot MCP server
 */
class GodotServer {
  private server: Server;
  private activeProcess: GodotProcess | null = null;
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private strictPathValidation: boolean = false;
  private maxOutputBufferSize: number = 10000; // Default to 10,000 lines

  /**
   * Parameter name mappings between snake_case and camelCase
   * This allows the server to accept both formats
   */
  private parameterMappings: Record<string, string> = {
    'project_path': 'projectPath',
    'scene_path': 'scenePath',
    'root_node_type': 'rootNodeType',
    'parent_node_path': 'parentNodePath',
    'node_type': 'nodeType',
    'node_name': 'nodeName',
    'texture_path': 'texturePath',
    'node_path': 'nodePath',
    'output_path': 'outputPath',
    'mesh_item_names': 'meshItemNames',
    'new_path': 'newPath',
    'file_path': 'filePath',
    'directory': 'directory',
    'recursive': 'recursive',
    'offset': 'offset',
    'limit': 'limit',
    'max_depth': 'maxDepth',
    'max_files': 'maxFiles',
    'include_summary_only': 'includeSummaryOnly',
    'scene': 'scene',
    'test_path': 'testPath',
    'test_prefix': 'testPrefix',
    'test_suffix': 'testSuffix',
    'exit_on_success': 'exitOnSuccess',
    'log_level': 'logLevel',
    'junit_xml_file': 'junitXmlFile',
    'test_directory': 'testDirectory',
    'test_name': 'testName',
    'template_type': 'templateType',
  };

  /**
   * Reverse mapping from camelCase to snake_case
   * Generated from parameterMappings for quick lookups
   */
  private reverseParameterMappings: Record<string, string> = {};

  constructor(config?: GodotServerConfig) {
    // Initialize reverse parameter mappings
    for (const [snakeCase, camelCase] of Object.entries(this.parameterMappings)) {
      this.reverseParameterMappings[camelCase] = snakeCase;
    }
    // Apply configuration if provided
    let debugMode = DEBUG_MODE;
    let godotDebugMode = GODOT_DEBUG_MODE;

    if (config) {
      if (config.debugMode !== undefined) {
        debugMode = config.debugMode;
      }
      if (config.godotDebugMode !== undefined) {
        godotDebugMode = config.godotDebugMode;
      }
      if (config.strictPathValidation !== undefined) {
        this.strictPathValidation = config.strictPathValidation;
      }
      if (config.maxOutputBufferSize !== undefined && config.maxOutputBufferSize > 0) {
        this.maxOutputBufferSize = config.maxOutputBufferSize;
      }

      // Store and validate custom Godot path if provided
      if (config.godotPath) {
        const normalizedPath = normalize(config.godotPath);
        this.godotPath = normalizedPath;
        this.logDebug(`Custom Godot path provided: ${this.godotPath}`);

        // Validate immediately with sync check
        if (!this.isValidGodotPathSync(this.godotPath)) {
          console.warn(`[SERVER] Invalid custom Godot path provided: ${this.godotPath}`);
          this.godotPath = null; // Reset to trigger auto-detection later
        }
      }
    }

    // Set the path to the operations script
    this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');
    if (debugMode) console.debug(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);

    // Initialize the MCP server
    this.server = new Server(
      {
        name: 'godot-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Set up tool handlers
    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);

    // Cleanup on exit
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Log debug messages if debug mode is enabled
   */
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.debug(`[DEBUG] ${message}`);
    }
  }

  /**
   * Create a standardized error response with possible solutions
   */
  private createErrorResponse(message: string, possibleSolutions: string[] = []): any {
    // Log the error
    console.error(`[SERVER] Error response: ${message}`);
    if (possibleSolutions.length > 0) {
      console.error(`[SERVER] Possible solutions: ${possibleSolutions.join(', ')}`);
    }

    const response: any = {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
      isError: true,
    };

    if (possibleSolutions.length > 0) {
      response.content.push({
        type: 'text',
        text: 'Possible solutions:\n- ' + possibleSolutions.join('\n- '),
      });
    }

    return response;
  }

  /**
   * Validate a path to prevent path traversal attacks
   */
  private validatePath(path: string): boolean {
    // Basic validation to prevent path traversal
    if (!path || path.includes('..')) {
      return false;
    }

    // Add more validation as needed
    return true;
  }

  /**
   * Synchronous validation for constructor use
   * This is a quick check that only verifies file existence, not executable validity
   * Full validation will be performed later in detectGodotPath
   * @param path Path to check
   * @returns True if the path exists or is 'godot' (which might be in PATH)
   */
  private isValidGodotPathSync(path: string): boolean {
    try {
      this.logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      return false;
    }
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    // Check cache first
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      this.logDebug(`Validating Godot path: ${path}`);

      // Check if the file exists (skip for 'godot' which might be in PATH)
      if (path !== 'godot' && !existsSync(path)) {
        this.logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      // Try to execute Godot with --version flag
      const command = path === 'godot' ? 'godot --version' : `"${path}" --version`;
      await execAsync(command);

      this.logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  private async detectGodotPath() {
    // If godotPath is already set and valid, use it
    if (this.godotPath && await this.isValidGodotPath(this.godotPath)) {
      this.logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    // Check environment variable next
    if (process.env.GODOT_PATH) {
      const normalizedPath = normalize(process.env.GODOT_PATH);
      this.logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      } else {
        this.logDebug(`GODOT_PATH environment variable is invalid`);
      }
    }

    // Auto-detect based on platform
    const osPlatform = process.platform;
    this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = [
      'godot', // Check if 'godot' is in PATH first
    ];

    // Add platform-specific paths
    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        'C:\\Program Files\\Godot_4\\Godot.exe',
        'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${process.env.HOME}/.local/bin/godot`
      );
    }

    // Try each possible path
    for (const path of possiblePaths) {
      const normalizedPath = normalize(path);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

    // If we get here, we couldn't find Godot
    this.logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    console.warn(`[SERVER] Could not find Godot in common locations for ${osPlatform}`);
    console.warn(`[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`);

    if (this.strictPathValidation) {
      // In strict mode, throw an error
      throw new Error(`Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`);
    } else {
      // Fallback to a default path in non-strict mode; this may not be valid and requires user configuration for reliability
      if (osPlatform === 'win32') {
        this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
      } else if (osPlatform === 'darwin') {
        this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
      } else {
        this.godotPath = normalize('/usr/bin/godot');
      }

      this.logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
      console.warn(`[SERVER] Using default path: ${this.godotPath}, but this may not work.`);
      console.warn(`[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`);
    }
  }

  /**
   * Set a custom Godot path
   * @param customPath Path to the Godot executable
   * @returns True if the path is valid and was set, false otherwise
   */
  public async setGodotPath(customPath: string): Promise<boolean> {
    if (!customPath) {
      return false;
    }

    // Normalize the path to ensure consistent format across platforms
    // (e.g., backslashes to forward slashes on Windows, resolving relative paths)
    const normalizedPath = normalize(customPath);
    if (await this.isValidGodotPath(normalizedPath)) {
      this.godotPath = normalizedPath;
      this.logDebug(`Godot path set to: ${normalizedPath}`);
      return true;
    }

    this.logDebug(`Failed to set invalid Godot path: ${normalizedPath}`);
    return false;
  }

  /**
   * Clean up resources when shutting down
   */
  private async cleanup() {
    this.logDebug('Cleaning up resources');
    if (this.activeProcess) {
      this.logDebug('Killing active Godot process');
      this.activeProcess.process.kill();
      this.activeProcess = null;
    }
    await this.server.close();
  }

  /**
   * Check if the Godot version is 4.4 or later
   * @param version The Godot version string
   * @returns True if the version is 4.4 or later
   */
  private isGodot44OrLater(version: string): boolean {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      return major > 4 || (major === 4 && minor >= 4);
    }
    return false;
  }

  /**
   * Normalize parameters to camelCase format
   * @param params Object with either snake_case or camelCase keys
   * @returns Object with all keys in camelCase format
   */
  private normalizeParameters(params: OperationParams): OperationParams {
    if (!params || typeof params !== 'object') {
      return params;
    }
    
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        let normalizedKey = key;
        
        // If the key is in snake_case, convert it to camelCase using our mapping
        if (key.includes('_') && this.parameterMappings[key]) {
          normalizedKey = this.parameterMappings[key];
        }
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[normalizedKey] = this.normalizeParameters(params[key] as OperationParams);
        } else {
          result[normalizedKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Convert camelCase keys to snake_case
   * @param params Object with camelCase keys
   * @returns Object with snake_case keys
   */
  private convertCamelToSnakeCase(params: OperationParams): OperationParams {
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        // Convert camelCase to snake_case
        const snakeKey = this.reverseParameterMappings[key] || key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[snakeKey] = this.convertCamelToSnakeCase(params[key] as OperationParams);
        } else {
          result[snakeKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Execute a Godot operation using the operations script
   * @param operation The operation to execute
   * @param params The parameters for the operation
   * @param projectPath The path to the Godot project
   * @returns The stdout and stderr from the operation
   */
  private async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string
  ): Promise<{ stdout: string; stderr: string }> {
    this.logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    this.logDebug(`Original operation params: ${JSON.stringify(params)}`);

    // Convert camelCase parameters to snake_case for Godot script
    const snakeCaseParams = this.convertCamelToSnakeCase(params);
    this.logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);


    // Ensure godotPath is set
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    try {
      // Serialize the snake_case parameters to a valid JSON string
      const paramsJson = JSON.stringify(snakeCaseParams);
      // Escape single quotes in the JSON string to prevent command injection
      const escapedParams = paramsJson.replace(/'/g, "'\\''");


      // Add debug arguments if debug mode is enabled
      const debugArgs = GODOT_DEBUG_MODE ? ['--debug-godot'] : [];

      // Construct the command with the operation and JSON parameters
      const cmd = [
        `"${this.godotPath}"`,
        '--headless',
        '--path',
        `"${projectPath}"`,
        '--script',
        `"${this.operationsScriptPath}"`,
        operation,
        `'${escapedParams}'`,  // Pass the JSON string as a single argument
        ...debugArgs,
      ].join(' ');

      this.logDebug(`Command: ${cmd}`);

      const { stdout, stderr } = await execAsync(cmd);

      return { stdout, stderr };
    } catch (error: unknown) {
      // If execAsync throws, it still contains stdout/stderr
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        return {
          stdout: execError.stdout,
          stderr: execError.stderr,
        };
      }

      throw error;
    }
  }

  /**
   * Get the structure of a Godot project
   * @param projectPath Path to the Godot project
   * @returns Object representing the project structure
   */
  private async getProjectStructure(projectPath: string): Promise<any> {
    try {
      // Get top-level directories in the project
      const entries = readdirSync(projectPath, { withFileTypes: true });

      const structure: any = {
        scenes: [],
        scripts: [],
        assets: [],
        other: [],
      };

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirName = entry.name.toLowerCase();

          // Skip hidden directories
          if (dirName.startsWith('.')) {
            continue;
          }

          // Count files in common directories
          if (dirName === 'scenes' || dirName.includes('scene')) {
            structure.scenes.push(entry.name);
          } else if (dirName === 'scripts' || dirName.includes('script')) {
            structure.scripts.push(entry.name);
          } else if (
            dirName === 'assets' ||
            dirName === 'textures' ||
            dirName === 'models' ||
            dirName === 'sounds' ||
            dirName === 'music'
          ) {
            structure.assets.push(entry.name);
          } else {
            structure.other.push(entry.name);
          }
        }
      }

      return structure;
    } catch (error) {
      this.logDebug(`Error getting project structure: ${error}`);
      return { error: 'Failed to get project structure' };
    }
  }

  /**
   * Find Godot projects in a directory
   * @param directory Directory to search
   * @param recursive Whether to search recursively
   * @returns Array of Godot projects
   */
  private findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }> {
    const projects: Array<{ path: string; name: string }> = [];

    try {
      // Check if the directory itself is a Godot project
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      // If not recursive, only check immediate subdirectories
      if (!recursive) {
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            }
          }
        }
      } else {
        // Recursive search
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            // Skip hidden directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            // Check if this directory is a Godot project
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            } else {
              // Recursively search this directory
              const subProjects = this.findGodotProjects(subdir, true);
              projects.push(...subProjects);
            }
          }
        }
      }
    } catch (error) {
      this.logDebug(`Error searching directory ${directory}: ${error}`);
    }

    return projects;
  }

  /**
   * Set up the tool handlers for the MCP server
   */
  private setupToolHandlers() {
    // Define available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'launch_editor',
          description: 'Launch Godot editor for a specific project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'run_project',
          description: 'Run the Godot project and capture output',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scene: {
                type: 'string',
                description: 'Optional: Specific scene to run',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_debug_output',
          description: 'Get the current debug output and errors with pagination support',
          inputSchema: {
            type: 'object',
            properties: {
              offset: {
                type: 'number',
                description: 'Starting line number (0-based)',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of lines to return (default: 1000)',
              },
              tail: {
                type: 'boolean',
                description: 'If true, return the last N lines (default: true)',
              },
            },
            required: [],
          },
        },
        {
          name: 'stop_project',
          description: 'Stop the currently running Godot project',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_godot_version',
          description: 'Get the installed Godot version',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'list_projects',
          description: 'List Godot projects in a directory with pagination support',
          inputSchema: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: 'Directory to search for Godot projects',
              },
              recursive: {
                type: 'boolean',
                description: 'Whether to search recursively (default: false)',
              },
              offset: {
                type: 'number',
                description: 'Number of projects to skip (for pagination)',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of projects to return (default: 100)',
              },
            },
            required: ['directory'],
          },
        },
        {
          name: 'get_project_info',
          description: 'Retrieve metadata about a Godot project with output limiting',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              maxDepth: {
                type: 'number',
                description: 'Maximum directory depth to scan (default: 5)',
              },
              maxFiles: {
                type: 'number',
                description: 'Maximum number of files to count per category (default: 1000)',
              },
              includeSummaryOnly: {
                type: 'boolean',
                description: 'Return only summary statistics instead of detailed structure (default: false)',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'create_scene',
          description: 'Create a new Godot scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path where the scene file will be saved (relative to project)',
              },
              rootNodeType: {
                type: 'string',
                description: 'Type of the root node (e.g., Node2D, Node3D)',
                default: 'Node2D',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'add_node',
          description: 'Add a node to an existing scene',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              parentNodePath: {
                type: 'string',
                description: 'Path to the parent node (e.g., "root" or "root/Player")',
                default: 'root',
              },
              nodeType: {
                type: 'string',
                description: 'Type of node to add (e.g., Sprite2D, CollisionShape2D)',
              },
              nodeName: {
                type: 'string',
                description: 'Name for the new node',
              },
              properties: {
                type: 'object',
                description: 'Optional properties to set on the node',
              },
            },
            required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
          },
        },
        {
          name: 'load_sprite',
          description: 'Load a sprite into a Sprite2D node',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              nodePath: {
                type: 'string',
                description: 'Path to the Sprite2D node (e.g., "root/Player/Sprite2D")',
              },
              texturePath: {
                type: 'string',
                description: 'Path to the texture file (relative to project)',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
          },
        },
        {
          name: 'export_mesh_library',
          description: 'Export a scene as a MeshLibrary resource',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (.tscn) to export',
              },
              outputPath: {
                type: 'string',
                description: 'Path where the mesh library (.res) will be saved',
              },
              meshItemNames: {
                type: 'array',
                items: {
                  type: 'string',
                },
                description: 'Optional: Names of specific mesh items to include (defaults to all)',
              },
            },
            required: ['projectPath', 'scenePath', 'outputPath'],
          },
        },
        {
          name: 'save_scene',
          description: 'Save changes to a scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              newPath: {
                type: 'string',
                description: 'Optional: New path to save the scene to (for creating variants)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'get_uid',
          description: 'Get the UID for a specific file in a Godot project (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              filePath: {
                type: 'string',
                description: 'Path to the file (relative to project) for which to get the UID',
              },
            },
            required: ['projectPath', 'filePath'],
          },
        },
        {
          name: 'update_project_uids',
          description: 'Update UID references in a Godot project by resaving resources (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'run_gut_tests',
          description: 'Run GUT (Godot Unit Testing) tests in a Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              testPath: {
                type: 'string',
                description: 'Optional: Specific test file or directory to run',
              },
              testPrefix: {
                type: 'string',
                description: 'Optional: Test file prefix (default: "test_")',
              },
              testSuffix: {
                type: 'string',
                description: 'Optional: Test file suffix (default: ".gd")',
              },
              exitOnSuccess: {
                type: 'boolean',
                description: 'Optional: Exit only if all tests pass (default: true)',
              },
              logLevel: {
                type: 'number',
                description: 'Optional: Log level (0-3, default: 1)',
              },
              junitXmlFile: {
                type: 'string',
                description: 'Optional: Path to export JUnit XML results',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'discover_gut_tests',
          description: 'Discover available GUT tests in a Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              testDirectory: {
                type: 'string',
                description: 'Optional: Directory to search for tests (default: "test")',
              },
              recursive: {
                type: 'boolean',
                description: 'Optional: Search recursively (default: true)',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'create_gut_test',
          description: 'Create a new GUT test file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              testPath: {
                type: 'string',
                description: 'Path where the test file will be created (relative to project)',
              },
              testName: {
                type: 'string',
                description: 'Name of the test class',
              },
              templateType: {
                type: 'string',
                description: 'Optional: Template type (basic, advanced, default: "basic")',
              },
            },
            required: ['projectPath', 'testPath', 'testName'],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      switch (request.params.name) {
        case 'launch_editor':
          return await this.handleLaunchEditor(request.params.arguments);
        case 'run_project':
          return await this.handleRunProject(request.params.arguments);
        case 'get_debug_output':
          return await this.handleGetDebugOutput(request.params.arguments);
        case 'stop_project':
          return await this.handleStopProject();
        case 'get_godot_version':
          return await this.handleGetGodotVersion();
        case 'list_projects':
          return await this.handleListProjects(request.params.arguments);
        case 'get_project_info':
          return await this.handleGetProjectInfo(request.params.arguments);
        case 'create_scene':
          return await this.handleCreateScene(request.params.arguments);
        case 'add_node':
          return await this.handleAddNode(request.params.arguments);
        case 'load_sprite':
          return await this.handleLoadSprite(request.params.arguments);
        case 'export_mesh_library':
          return await this.handleExportMeshLibrary(request.params.arguments);
        case 'save_scene':
          return await this.handleSaveScene(request.params.arguments);
        case 'get_uid':
          return await this.handleGetUid(request.params.arguments);
        case 'update_project_uids':
          return await this.handleUpdateProjectUids(request.params.arguments);
        case 'run_gut_tests':
          return await this.handleRunGutTests(request.params.arguments);
        case 'discover_gut_tests':
          return await this.handleDiscoverGutTests(request.params.arguments);
        case 'create_gut_test':
          return await this.handleCreateGutTest(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  /**
   * Handle the launch_editor tool
   * @param args Tool arguments
   */
  private async handleLaunchEditor(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      this.logDebug(`Launching Godot editor for project: ${args.projectPath}`);
      const process = spawn(this.godotPath, ['-e', '--path', args.projectPath], {
        stdio: 'pipe',
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot editor:', err);
      });

      return {
        content: [
          {
            type: 'text',
            text: `Godot editor launched successfully for project at ${args.projectPath}.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to launch Godot editor: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the run_project tool
   * @param args Tool arguments
   */
  private async handleRunProject(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Kill any existing process
      if (this.activeProcess) {
        this.logDebug('Killing existing Godot process before starting a new one');
        this.activeProcess.process.kill();
      }

      const cmdArgs = ['-d', '--path', args.projectPath];
      if (args.scene && this.validatePath(args.scene)) {
        this.logDebug(`Adding scene parameter: ${args.scene}`);
        cmdArgs.push(args.scene);
      }

      this.logDebug(`Running Godot project: ${args.projectPath}`);
      const process = spawn(this.godotPath!, cmdArgs, { stdio: 'pipe' });
      const output: string[] = [];
      const errors: string[] = [];

      process.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        output.push(...lines);
        
        // Trim buffer if it exceeds maximum size
        if (output.length > this.maxOutputBufferSize) {
          const excessLines = output.length - this.maxOutputBufferSize;
          output.splice(0, excessLines);
          this.logDebug(`[Godot stdout] Trimmed ${excessLines} lines from output buffer`);
        }
        
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stdout] ${line}`);
        });
      });

      process.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        errors.push(...lines);
        
        // Trim buffer if it exceeds maximum size
        if (errors.length > this.maxOutputBufferSize) {
          const excessLines = errors.length - this.maxOutputBufferSize;
          errors.splice(0, excessLines);
          this.logDebug(`[Godot stderr] Trimmed ${excessLines} lines from error buffer`);
        }
        
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stderr] ${line}`);
        });
      });

      process.on('exit', (code: number | null) => {
        this.logDebug(`Godot process exited with code ${code}`);
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
        }
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot process:', err);
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
        }
      });

      this.activeProcess = { process, output, errors };

      return {
        content: [
          {
            type: 'text',
            text: `Godot project started in debug mode. Use get_debug_output to see output.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to run Godot project: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_debug_output tool
   */
  private async handleGetDebugOutput(args: any = {}) {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process.',
        [
          'Use run_project to start a Godot project first',
          'Check if the Godot process crashed unexpectedly',
        ]
      );
    }

    // Parse pagination parameters with defaults
    const limit = args.limit || 1000;
    const offset = args.offset || 0;
    const tail = args.tail !== false; // Default to true

    const totalOutput = this.activeProcess.output.length;
    const totalErrors = this.activeProcess.errors.length;

    let outputSlice: string[];
    let errorsSlice: string[];
    let actualOffset: number;

    if (tail && offset === 0) {
      // Tail mode: get the last N lines
      actualOffset = Math.max(0, totalOutput - limit);
      outputSlice = this.activeProcess.output.slice(-limit);
      errorsSlice = this.activeProcess.errors.slice(-limit);
    } else {
      // Regular pagination mode
      actualOffset = offset;
      outputSlice = this.activeProcess.output.slice(offset, offset + limit);
      errorsSlice = this.activeProcess.errors.slice(offset, offset + limit);
    }

    const hasMoreOutput = (actualOffset + outputSlice.length) < totalOutput;
    const hasMoreErrors = (actualOffset + errorsSlice.length) < totalErrors;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              output: outputSlice,
              errors: errorsSlice,
              pagination: {
                offset: actualOffset,
                limit: limit,
                totalOutput: totalOutput,
                totalErrors: totalErrors,
                hasMore: hasMoreOutput || hasMoreErrors,
                tail: tail && offset === 0,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the stop_project tool
   */
  private async handleStopProject() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process to stop.',
        [
          'Use run_project to start a Godot project first',
          'The process may have already terminated',
        ]
      );
    }

    this.logDebug('Stopping active Godot process');
    this.activeProcess.process.kill();
    const output = this.activeProcess.output;
    const errors = this.activeProcess.errors;
    this.activeProcess = null;

    // Return only the last 1000 lines to avoid oversized responses
    const maxLines = 1000;
    const outputTail = output.slice(-maxLines);
    const errorsTail = errors.slice(-maxLines);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Godot project stopped',
              finalOutput: outputTail,
              finalErrors: errorsTail,
              summary: {
                totalOutputLines: output.length,
                totalErrorLines: errors.length,
                outputTruncated: output.length > maxLines,
                errorsTruncated: errors.length > maxLines,
                maxLinesReturned: maxLines,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the get_godot_version tool
   */
  private async handleGetGodotVersion() {
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      this.logDebug('Getting Godot version');
      const { stdout } = await execAsync(`"${this.godotPath}" --version`);
      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to get Godot version: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
        ]
      );
    }
  }

  /**
   * Handle the list_projects tool
   */
  private async handleListProjects(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.directory) {
      return this.createErrorResponse(
        'Directory is required',
        ['Provide a valid directory path to search for Godot projects']
      );
    }

    if (!this.validatePath(args.directory)) {
      return this.createErrorResponse(
        'Invalid directory path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return this.createErrorResponse(
          `Directory does not exist: ${args.directory}`,
          ['Provide a valid directory path that exists on the system']
        );
      }

      const recursive = args.recursive === true;
      const offset = args.offset || 0;
      const limit = args.limit || 100;
      
      const allProjects = this.findGodotProjects(args.directory, recursive);
      const totalProjects = allProjects.length;
      
      // Apply pagination
      const paginatedProjects = allProjects.slice(offset, offset + limit);
      
      const result = {
        projects: paginatedProjects,
        pagination: {
          offset: offset,
          limit: limit,
          total: totalProjects,
          hasMore: offset + limit < totalProjects,
        },
      };

      return this.createSizeLimitedResponse(JSON.stringify(result, null, 2), 'project list');
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list projects: ${error?.message || 'Unknown error'}`,
        [
          'Ensure the directory exists and is accessible',
          'Check if you have permission to read the directory',
        ]
      );
    }
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
   */
  private getProjectStructureAsync(
    projectPath: string, 
    maxDepth: number = 5, 
    maxFiles: number = 1000, 
    includeSummaryOnly: boolean = false
  ): Promise<any> {
    return new Promise((resolve) => {
      try {
        const structure = {
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        };

        let totalFilesCounted = 0;
        let maxFilesReached = false;
        let maxDepthReached = false;

        const scanDirectory = (currentPath: string, currentDepth: number = 0) => {
          // Check depth limit
          if (currentDepth > maxDepth) {
            maxDepthReached = true;
            return;
          }
          
          // Check if we've already reached the max files limit
          if (totalFilesCounted >= maxFiles) {
            maxFilesReached = true;
            return;
          }

          const entries = readdirSync(currentPath, { withFileTypes: true });
          
          for (const entry of entries) {
            // Early exit if max files reached
            if (totalFilesCounted >= maxFiles) {
              maxFilesReached = true;
              break;
            }

            const entryPath = join(currentPath, entry.name);
            
            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            
            if (entry.isDirectory()) {
              // Recursively scan subdirectories with depth tracking
              scanDirectory(entryPath, currentDepth + 1);
            } else if (entry.isFile()) {
              totalFilesCounted++;
              
              // Count file by extension
              const ext = entry.name.split('.').pop()?.toLowerCase();
              
              if (ext === 'tscn') {
                structure.scenes++;
              } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
                structure.scripts++;
              } else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')) {
                structure.assets++;
              } else {
                structure.other++;
              }
            }
          }
        };
        
        // Start scanning from the project root
        scanDirectory(projectPath, 0);

        // Build result based on includeSummaryOnly flag
        const result = includeSummaryOnly ? {
          totalFiles: totalFilesCounted,
          summary: {
            scenes: structure.scenes,
            scripts: structure.scripts,
            assets: structure.assets,
            other: structure.other,
            totalCounted: structure.scenes + structure.scripts + structure.assets + structure.other,
          },
          limitations: {
            maxDepthReached,
            maxFilesReached,
            actualDepthScanned: maxDepthReached ? maxDepth : 'full',
            actualFilesScanned: totalFilesCounted,
          }
        } : {
          ...structure,
          totalFiles: totalFilesCounted,
          limitations: {
            maxDepthReached,
            maxFilesReached,
            actualDepthScanned: maxDepthReached ? maxDepth : 'full',
            actualFilesScanned: totalFilesCounted,
          }
        };

        resolve(result);
      } catch (error) {
        this.logDebug(`Error getting project structure asynchronously: ${error}`);
        resolve({ 
          error: 'Failed to get project structure',
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0
        });
      }
    });
  }

  /**
   * Handle the get_project_info tool
   */
  private async handleGetProjectInfo(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }
  
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }
  
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }
  
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }
  
      this.logDebug(`Getting project info for: ${args.projectPath}`);
  
      // Get Godot version
      const execOptions = { timeout: 10000 }; // 10 second timeout
      const { stdout } = await execAsync(`"${this.godotPath}" --version`, execOptions);
  
      // Get project structure using the recursive method with limits
      const maxDepth = args.maxDepth || 5;
      const maxFiles = args.maxFiles || 1000;
      const includeSummaryOnly = args.includeSummaryOnly || false;
      
      const projectStructure = await this.getProjectStructureAsync(
        args.projectPath, 
        maxDepth, 
        maxFiles, 
        includeSummaryOnly
      );
  
      // Extract project name from project.godot file
      let projectName = basename(args.projectPath);
      try {
        const fs = require('fs');
        const projectFileContent = fs.readFileSync(projectFile, 'utf8');
        const configNameMatch = projectFileContent.match(/config\/name="([^"]+)"/);
        if (configNameMatch && configNameMatch[1]) {
          projectName = configNameMatch[1];
          this.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.logDebug(`Error reading project file: ${error}`);
        // Continue with default project name if extraction fails
      }
  
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: projectName,
                path: args.projectPath,
                godotVersion: stdout.trim(),
                structure: projectStructure,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get project info: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the create_scene tool
   */
  private async handleCreateScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Project path and scene path are required',
        ['Provide valid paths for both the project and the scene']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        rootNodeType: args.rootNodeType || 'Node2D',
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('create_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to create scene: ${stderr}`,
          [
            'Check if the root node type is valid',
            'Ensure you have write permissions to the scene path',
            'Verify the scene path is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the add_node tool
   */
  private async handleAddNode(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodeType, and nodeName']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        nodeType: args.nodeType,
        nodeName: args.nodeName,
      };

      // Add optional parameters
      if (args.parentNodePath) {
        params.parentNodePath = args.parentNodePath;
      }

      if (args.properties) {
        params.properties = args.properties;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('add_node', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to add node: ${stderr}`,
          [
            'Check if the node type is valid',
            'Ensure the parent node path exists',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to add node: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the load_sprite tool
   */
  private async handleLoadSprite(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, and texturePath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath) ||
      !this.validatePath(args.texturePath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Check if the texture file exists
      const texturePath = join(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return this.createErrorResponse(
          `Texture file does not exist: ${args.texturePath}`,
          [
            'Ensure the texture path is correct',
            'Upload or create the texture file first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        texturePath: args.texturePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('load_sprite', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to load sprite: ${stderr}`,
          [
            'Check if the node path is correct',
            'Ensure the node is a Sprite2D, Sprite3D, or TextureRect',
            'Verify the texture file is a valid image format',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to load sprite: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the export_mesh_library tool
   */
  private async handleExportMeshLibrary(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.outputPath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, and outputPath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.outputPath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        outputPath: args.outputPath,
      };

      // Add optional parameters
      if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
        params.meshItemNames = args.meshItemNames;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('export_mesh_library', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to export mesh library: ${stderr}`,
          [
            'Check if the scene contains valid 3D meshes',
            'Ensure the output path is valid',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to export mesh library: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the save_scene tool
   */
  private async handleSaveScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and scenePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    // If newPath is provided, validate it
    if (args.newPath && !this.validatePath(args.newPath)) {
      return this.createErrorResponse(
        'Invalid new path',
        ['Provide a valid new path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
      };

      // Add optional parameters
      if (args.newPath) {
        params.newPath = args.newPath;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('save_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to save scene: ${stderr}`,
          [
            'Check if the scene file is valid',
            'Ensure you have write permissions to the output path',
            'Verify the scene can be properly packed',
          ]
        );
      }

      const savePath = args.newPath || args.scenePath;
      return {
        content: [
          {
            type: 'text',
            text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to save scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_uid tool
   */
  private async handleGetUid(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.filePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and filePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.filePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the file exists
      const filePath = join(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return this.createErrorResponse(
          `File does not exist: ${args.filePath}`,
          ['Ensure the file path is correct']
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execAsync(`"${this.godotPath}" --version`);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        filePath: args.filePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('get_uid', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to get UID: ${stderr}`,
          [
            'Check if the file is a valid Godot resource',
            'Ensure the file path is correct',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `UID for ${args.filePath}: ${stdout.trim()}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get UID: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Maximum response size in characters to prevent oversized JSON responses
   */
  private readonly MAX_RESPONSE_SIZE = 50000;

  /**
   * Check and limit response size to prevent oversized JSON that could crash Claude Code
   */
  private limitResponseSize(content: string, context: string = 'output'): string {
    if (content.length <= this.MAX_RESPONSE_SIZE) {
      return content;
    }

    const truncateSize = this.MAX_RESPONSE_SIZE - 500; // Leave room for truncation message
    const truncated = content.substring(0, truncateSize);
    const totalLines = content.split('\n').length;
    const shownLines = truncated.split('\n').length;
    
    const truncationMessage = `\n\n[TRUNCATED: Response was ${content.length} characters (${totalLines} lines). Showing first ${truncated.length} characters (${shownLines} lines) to prevent oversized response. Use pagination or filtering parameters to get specific portions of the output.]`;
    
    return truncated + truncationMessage;
  }

  /**
   * Create a response with automatic size limiting
   */
  private createSizeLimitedResponse(content: string, context: string = 'output') {
    const limitedContent = this.limitResponseSize(content, context);
    
    return {
      content: [
        {
          type: 'text',
          text: limitedContent,
        },
      ],
    };
  }

  /**
   * Parse resave_resources output to create a summary
   */
  private parseResaveResourcesOutput(stdout: string): any {
    const lines = stdout.split('\n');
    let summary = {
      status: 'completed',
      scenesProcessed: 0,
      scenesSuccessful: 0,
      scenesWithErrors: 0,
      scriptsMissingUIDs: 0,
      uidsGenerated: 0,
      errors: [] as string[],
      message: 'Project UIDs updated successfully',
    };

    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Parse summary information from debug output
      if (trimmedLine.includes('Scenes processed:')) {
        const match = trimmedLine.match(/Scenes processed:\s*(\d+)/);
        if (match) summary.scenesProcessed = parseInt(match[1], 10);
      }
      
      if (trimmedLine.includes('Scenes successfully saved:')) {
        const match = trimmedLine.match(/Scenes successfully saved:\s*(\d+)/);
        if (match) summary.scenesSuccessful = parseInt(match[1], 10);
      }
      
      if (trimmedLine.includes('Scenes with errors:')) {
        const match = trimmedLine.match(/Scenes with errors:\s*(\d+)/);
        if (match) summary.scenesWithErrors = parseInt(match[1], 10);
      }
      
      if (trimmedLine.includes('Scripts/shaders missing UIDs:')) {
        const match = trimmedLine.match(/Scripts\/shaders missing UIDs:\s*(\d+)/);
        if (match) summary.scriptsMissingUIDs = parseInt(match[1], 10);
      }
      
      if (trimmedLine.includes('UIDs successfully generated:')) {
        const match = trimmedLine.match(/UIDs successfully generated:\s*(\d+)/);
        if (match) summary.uidsGenerated = parseInt(match[1], 10);
      }

      // Collect error messages
      if (trimmedLine.includes('[ERROR]') || trimmedLine.includes('Failed to')) {
        summary.errors.push(trimmedLine);
      }
    }

    // Determine overall status
    if (summary.errors.length > 0 || summary.scenesWithErrors > 0) {
      summary.status = 'completed_with_errors';
      summary.message = `Project UIDs updated with ${summary.errors.length + summary.scenesWithErrors} errors`;
    }

    // If we didn't find any structured output, provide basic parsing
    if (summary.scenesProcessed === 0 && summary.scenesSuccessful === 0) {
      // Count operations mentioned in the output
      const sceneMatches = stdout.match(/Processing scene:/g);
      const successMatches = stdout.match(/Scene loaded successfully/g);
      const errorMatches = stdout.match(/Failed to|Error:/g);
      
      summary.scenesProcessed = sceneMatches ? sceneMatches.length : 0;
      summary.scenesSuccessful = successMatches ? successMatches.length : 0;
      summary.scenesWithErrors = errorMatches ? errorMatches.length : 0;
    }

    return summary;
  }

  /**
   * Handle the update_project_uids tool
   */
  private async handleUpdateProjectUids(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execAsync(`"${this.godotPath}" --version`);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        projectPath: args.projectPath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('resave_resources', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to update project UIDs: ${stderr}`,
          [
            'Check if the project is valid',
            'Ensure you have write permissions to the project directory',
          ]
        );
      }

      // Parse and summarize the output to prevent oversized responses
      const summary = this.parseResaveResourcesOutput(stdout);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to update project UIDs: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the run_gut_tests tool
   */
  private async handleRunGutTests(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if GUT is installed in the project
      const gutPath = join(args.projectPath, 'addons', 'gut');
      if (!existsSync(gutPath)) {
        return this.createErrorResponse(
          'GUT addon not found in project',
          [
            'Install GUT addon from the Asset Library',
            'Ensure addons/gut directory exists in the project',
            'Download GUT from https://github.com/bitwes/Gut',
          ]
        );
      }

      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Build GUT command arguments
      const gutArgs = ['-d', '-s', '--path', args.projectPath, 'addons/gut/gut_cmdln.gd'];

      // Add optional parameters
      if (args.testPath) {
        if (args.testPath.endsWith('.gd')) {
          gutArgs.push('-gtest=' + args.testPath);
        } else {
          gutArgs.push('-gdir=' + args.testPath);
        }
      }

      if (args.testPrefix) {
        gutArgs.push('-gprefix=' + args.testPrefix);
      }

      if (args.testSuffix) {
        gutArgs.push('-gsuffix=' + args.testSuffix);
      }

      if (args.exitOnSuccess !== false) {
        gutArgs.push('-gexit');
      }

      if (args.logLevel !== undefined) {
        gutArgs.push('-glog=' + args.logLevel);
      }

      if (args.junitXmlFile) {
        gutArgs.push('-gjunit_xml_file=' + args.junitXmlFile);
      }

      this.logDebug(`Running GUT tests with command: ${this.godotPath} ${gutArgs.join(' ')}`);

      // Execute GUT tests
      const { stdout, stderr } = await execAsync(`"${this.godotPath}" ${gutArgs.join(' ')}`);

      // Parse the output to extract test results
      const testResults = this.parseGutTestOutput(stdout, stderr);

      return this.createSizeLimitedResponse(JSON.stringify(testResults, null, 2), 'test results');
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to run GUT tests: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if GUT addon is properly installed',
          'Verify the project path is accessible',
          'Check if test files exist in the specified path',
        ]
      );
    }
  }

  /**
   * Handle the discover_gut_tests tool
   */
  private async handleDiscoverGutTests(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if GUT is installed
      const gutPath = join(args.projectPath, 'addons', 'gut');
      const gutInstalled = existsSync(gutPath);

      // Default test directory
      const testDirectory = args.testDirectory || 'test';
      const testPath = join(args.projectPath, testDirectory);
      
      const testFiles = this.findGutTestFiles(testPath, args.recursive !== false);

      const result = {
        gutInstalled,
        gutPath: gutInstalled ? gutPath : null,
        testDirectory,
        testFiles,
        summary: {
          totalTestFiles: testFiles.length,
          testDirectoryExists: existsSync(testPath),
        }
      };

      return this.createSizeLimitedResponse(JSON.stringify(result, null, 2), 'test discovery');
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to discover GUT tests: ${error?.message || 'Unknown error'}`,
        [
          'Ensure the project path is accessible',
          'Check if the test directory exists',
          'Verify you have read permissions for the project directory',
        ]
      );
    }
  }

  /**
   * Handle the create_gut_test tool
   */
  private async handleCreateGutTest(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.testPath || !args.testName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, testPath, and testName']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.testPath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if GUT is installed
      const gutPath = join(args.projectPath, 'addons', 'gut');
      if (!existsSync(gutPath)) {
        return this.createErrorResponse(
          'GUT addon not found in project',
          [
            'Install GUT addon from the Asset Library',
            'Ensure addons/gut directory exists in the project',
            'Download GUT from https://github.com/bitwes/Gut',
          ]
        );
      }

      // Prepare parameters for the operation
      const params = {
        testPath: args.testPath,
        testName: args.testName,
        templateType: args.templateType || 'basic',
      };

      // Execute the operation using the Godot operations script
      const { stdout, stderr } = await this.executeOperation('create_gut_test', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to create GUT test: ${stderr}`,
          [
            'Check if the test path is valid',
            'Ensure you have write permissions to the test directory',
            'Verify the test name is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `GUT test created successfully at: ${args.testPath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create GUT test: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
          'Ensure GUT addon is properly installed',
        ]
      );
    }
  }

  /**
   * Parse GUT test output to extract test results
   */
  private parseGutTestOutput(stdout: string, stderr: string): any {
    const lines = stdout.split('\n');
    let testResults = {
      summary: {
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        pendingTests: 0,
        skippedTests: 0,
        runtime: 0,
      },
      testFiles: [] as any[],
      failures: [] as any[],
      output: stdout,
      errors: stderr,
    };

    // Parse GUT output for test results
    // GUT typically outputs results in a specific format
    for (const line of lines) {
      // Extract test summary information
      if (line.includes('Tests:')) {
        const match = line.match(/Tests:\s*(\d+)\s*Passed:\s*(\d+)\s*Failed:\s*(\d+)/);
        if (match) {
          testResults.summary.totalTests = parseInt(match[1], 10);
          testResults.summary.passedTests = parseInt(match[2], 10);
          testResults.summary.failedTests = parseInt(match[3], 10);
        }
      }

      // Extract runtime information
      if (line.includes('Runtime:')) {
        const match = line.match(/Runtime:\s*([\d.]+)/);
        if (match) {
          testResults.summary.runtime = parseFloat(match[1]);
        }
      }

      // Extract test file information
      if (line.includes('Running tests in:') || line.includes('Test script:')) {
        const testFile = line.split(':')[1]?.trim();
        if (testFile) {
          testResults.testFiles.push({
            path: testFile,
            status: 'completed',
          });
        }
      }

      // Extract failure information
      if (line.includes('FAILED:') || line.includes('ERROR:')) {
        testResults.failures.push({
          message: line,
          type: line.includes('FAILED:') ? 'failure' : 'error',
        });
      }
    }

    return testResults;
  }

  /**
   * Find GUT test files in a directory
   */
  private findGutTestFiles(directory: string, recursive: boolean): Array<{ path: string; name: string; relativePath: string }> {
    const testFiles: Array<{ path: string; name: string; relativePath: string }> = [];

    if (!existsSync(directory)) {
      return testFiles;
    }

    try {
      const entries = readdirSync(directory, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(directory, entry.name);

        if (entry.isFile() && entry.name.startsWith('test_') && entry.name.endsWith('.gd')) {
          testFiles.push({
            path: fullPath,
            name: entry.name,
            relativePath: entry.name,
          });
        } else if (entry.isDirectory() && recursive && !entry.name.startsWith('.')) {
          const subTests = this.findGutTestFiles(fullPath, true);
          testFiles.push(...subTests.map(test => ({
            ...test,
            relativePath: join(entry.name, test.relativePath),
          })));
        }
      }
    } catch (error) {
      this.logDebug(`Error reading test directory ${directory}: ${error}`);
    }

    return testFiles;
  }

  /**
   * Run the MCP server
   */
  async run() {
    try {
      // Detect Godot path before starting the server
      await this.detectGodotPath();

      if (!this.godotPath) {
        console.error('[SERVER] Failed to find a valid Godot executable path');
        console.error('[SERVER] Please set GODOT_PATH environment variable or provide a valid path');
        process.exit(1);
      }

      // Check if the path is valid
      const isValid = await this.isValidGodotPath(this.godotPath);

      if (!isValid) {
        if (this.strictPathValidation) {
          // In strict mode, exit if the path is invalid
          console.error(`[SERVER] Invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path');
          process.exit(1);
        } else {
          // In compatibility mode, warn but continue with the default path
          console.warn(`[SERVER] Warning: Using potentially invalid Godot path: ${this.godotPath}`);
          console.warn('[SERVER] This may cause issues when executing Godot commands');
          console.warn('[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.');
        }
      }

      console.log(JSON.stringify({
        jsonrpc: "2.0",
        method: "server/log",
        params: {
          message: `Using Godot at: ${this.godotPath}`
        }
      }));

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Godot MCP server running on stdio');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SERVER] Failed to start:', errorMessage);
      process.exit(1);
    }
  }
}

// Create and run the server
const server = new GodotServer();
server.run().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', errorMessage);
  process.exit(1);
});
