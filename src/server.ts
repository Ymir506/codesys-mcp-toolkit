/**
 * server.ts
 * MCP Server for interacting with CODESYS via Python scripting.
 * Implements all MCP resources and tools that interact with the CODESYS environment.
 *
 * IMPORTANT: This server receives configuration as parameters from bin.ts,
 * which helps avoid issues with command-line argument passing in different execution environments.
 * (Incorporates script templates from v1.6.9 and improved tool descriptions)
 */

// --- Import 'os' FIRST ---
import * as os from 'os';
// --- End Import 'os' ---

// --- STARTUP LOG ---
console.error(`>>> SERVER.TS TOP LEVEL EXECUTION @ ${new Date().toISOString()} <<<`);
console.error(`>>> Node: ${process.version}, Platform: ${os.platform()}, Arch: ${os.arch()}`);
console.error(`>>> Initial CWD: ${process.cwd()}`);
// --- End Startup Log ---

// --- Necessary Imports ---
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { executeCodesysScript } from "./codesys_interop"; // Assumes this utility exists
import * as path from 'path';
import { stat } from "fs/promises"; // For file existence check (async)
import * as fsPromises from 'fs/promises'; // Use promises version of fs
// --- End Imports ---

// --- Define an interface for configuration ---
interface ServerConfig {
    codesysPath: string;
    profileName: string;
    workspaceDir: string;
}

// --- Wrap server logic in an exported function ---
export async function startMcpServer(config: ServerConfig) {

    console.error(`>>> SERVER.TS startMcpServer() CALLED @ ${new Date().toISOString()} <<<`);
    console.error(`>>> Config Received: ${JSON.stringify(config)}`);

    // --- Use config values directly ---
    const WORKSPACE_DIR = config.workspaceDir;
    const codesysExePath = config.codesysPath;
    const codesysProfileName = config.profileName;

    console.error(`SERVER.TS: Using Workspace Directory: ${WORKSPACE_DIR}`);
    console.error(`SERVER.TS: Using CODESYS Path: ${codesysExePath}`);
    console.error(`SERVER.TS: Using CODESYS Profile: ${codesysProfileName}`);

    // --- Sanity check - confirm the path exists if possible ---
    // This helps catch configuration issues early and prevents runtime failures
    console.error(`SERVER.TS: Checking existence of CODESYS executable: ${codesysExePath}`);
    try {
        // Using sync check here as it's part of initial setup before async operations start
        const fsChecker = require('fs');
        if (!fsChecker.existsSync(codesysExePath)) {
            console.error(`SERVER.TS ERROR: Determined CODESYS executable path does not exist: ${codesysExePath}`);
            // Consider throwing an error instead of exiting if bin.ts handles the catch
            throw new Error(`CODESYS executable not found at specified path: ${codesysExePath}`);
            // process.exit(1); // Avoid process.exit inside library functions if possible
        } else {
            console.error(`SERVER.TS: Confirmed CODESYS executable exists.`);
        }
    } catch (err: any) {
        console.error(`SERVER.TS ERROR: Error checking CODESYS path existence: ${err.message}`);
        throw err; // Rethrow the error to be caught by the caller (bin.ts)
        // process.exit(1);
    }
    // --- End Configuration Handling ---

    // --- Helper Function (fileExists - async version) ---
    async function fileExists(filePath: string): Promise<boolean> {
        try {
            await stat(filePath);
            return true;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return false; // File does not exist
            }
            throw error; // Other error
        }
    }
    // --- End Helper Function ---

    // --- MCP Server Initialization ---
    console.error("SERVER.TS: Initializing McpServer...");
    const server = new McpServer({
        name: "CODESYS Control MCP Server",
        version: "1.7.1", // Update version as needed
        capabilities: {
            // Explicitly declare capabilities - enables listChanged notifications if supported by SDK
            resources: { listChanged: true }, // Assuming you might want to notify if resources change dynamically
            tools: { listChanged: true }      // Assuming you might want to notify if tools change dynamically (less common)
         }
    });
    console.error("SERVER.TS: McpServer instance created.");
    // --- End MCP Server Initialization ---


    // --- Python Script Templates (Imported from v1.6.9) ---

    const ENSURE_PROJECT_OPEN_PYTHON_SNIPPET = `
import sys
import scriptengine as script_engine
import os
import time
import traceback

# --- Function to ensure the correct project is open ---
MAX_RETRIES = 3
RETRY_DELAY = 2.0 # seconds (use float for time.sleep)

def ensure_project_open(target_project_path):
    print("DEBUG: Ensuring project is open: %s" % target_project_path)
    # Normalize target path once
    normalized_target_path = os.path.normcase(os.path.abspath(target_project_path))

    for attempt in range(MAX_RETRIES):
        print("DEBUG: Ensure project attempt %d/%d for %s" % (attempt + 1, MAX_RETRIES, normalized_target_path))
        primary_project = None
        try:
            # Getting primary project might fail if CODESYS instance is unstable
            primary_project = script_engine.projects.primary
        except Exception as primary_err:
             print("WARN: Error getting primary project: %s. Assuming none." % primary_err)
             # traceback.print_exc() # Optional: Print stack trace for this error
             primary_project = None

        current_project_path = ""
        project_ok = False # Flag to check if target is confirmed primary and accessible

        if primary_project:
            try:
                # Getting path should be relatively safe if primary_project object exists
                current_project_path = os.path.normcase(os.path.abspath(primary_project.path))
                print("DEBUG: Current primary project path: %s" % current_project_path)
                if current_project_path == normalized_target_path:
                    # Found the right project as primary, now check if it's usable
                    print("DEBUG: Target project path matches primary. Checking access...")
                    try:
                         # Try a relatively safe operation to confirm object usability
                         # Getting children count is a reasonable check
                         _ = len(primary_project.get_children(False))
                         print("DEBUG: Target project '%s' is primary and accessible." % target_project_path)
                         project_ok = True
                         return primary_project # SUCCESS CASE 1: Already open and accessible
                    except Exception as access_err:
                         # Project found, but accessing it failed. Might be unstable.
                         print("WARN: Primary project access check failed for '%s': %s. Will attempt reopen." % (current_project_path, access_err))
                         # traceback.print_exc() # Optional: Print stack trace
                         primary_project = None # Force reopen by falling through
                else:
                    # A *different* project is primary
                     print("DEBUG: Primary project is '%s', not the target '%s'." % (current_project_path, normalized_target_path))
                     # Consider closing the wrong project if causing issues, but for now, just open target
                     # try:
                     #     print("DEBUG: Closing incorrect primary project '%s'..." % current_project_path)
                     #     primary_project.close() # Be careful with unsaved changes
                     # except Exception as close_err:
                     #     print("WARN: Failed to close incorrect primary project: %s" % close_err)
                     primary_project = None # Force open target project

            except Exception as path_err:
                 # Failed even to get the path of the supposed primary project
                 print("WARN: Could not get path of current primary project: %s. Assuming not the target." % path_err)
                 # traceback.print_exc() # Optional: Print stack trace
                 primary_project = None # Force open target project

        # If target project not confirmed as primary and accessible, attempt to open/reopen
        if not project_ok:
            # Log clearly whether we are opening initially or reopening
            if primary_project is None and current_project_path == "":
                print("DEBUG: No primary project detected. Attempting to open target: %s" % target_project_path)
            elif primary_project is None and current_project_path != "":
                 print("DEBUG: Primary project was '%s' but failed access check or needed close. Attempting to open target: %s" % (current_project_path, target_project_path))
            else: # Includes cases where wrong project was open
                print("DEBUG: Target project not primary or initial check failed. Attempting to open/reopen: %s" % target_project_path)

            try:
                # Set flags for silent opening, handle potential attribute errors
                update_mode = script_engine.VersionUpdateFlags.NoUpdates | script_engine.VersionUpdateFlags.SilentMode
                # try:
                #     update_mode = script_engine.VersionUpdateFlags.NoUpdates | script_engine.VersionUpdateFlags.SilentMode
                # except AttributeError:
                #     print("WARN: VersionUpdateFlags not found, using integer flags for open (1 | 2 = 3).")
                #     update_mode = 3 # 1=NoUpdates, 2=SilentMode

                opened_project = None
                try:
                     # The actual open call
                     print("DEBUG: Calling script_engine.projects.open('%s', update_flags=%s)..." % (target_project_path, update_mode))
                     opened_project = script_engine.projects.open(target_project_path, update_flags=update_mode)

                     if not opened_project:
                         # This is a critical failure if open returns None without exception
                         print("ERROR: projects.open returned None for %s on attempt %d" % (target_project_path, attempt + 1))
                         # Allow retry loop to continue
                     else:
                         # Open call returned *something*, let's verify
                         print("DEBUG: projects.open call returned an object for: %s" % target_project_path)
                         print("DEBUG: Pausing for stabilization after open...")
                         time.sleep(RETRY_DELAY) # Give CODESYS time
                         # Re-verify: Is the project now primary and accessible?
                         recheck_primary = None
                         try: recheck_primary = script_engine.projects.primary
                         except Exception as recheck_primary_err: print("WARN: Error getting primary project after reopen: %s" % recheck_primary_err)

                         if recheck_primary:
                              recheck_path = ""
                              try: # Getting path might fail
                                  recheck_path = os.path.normcase(os.path.abspath(recheck_primary.path))
                              except Exception as recheck_path_err:
                                  print("WARN: Failed to get path after reopen: %s" % recheck_path_err)

                              if recheck_path == normalized_target_path:
                                   print("DEBUG: Target project confirmed as primary after reopening.")
                                   try: # Final sanity check
                                       _ = len(recheck_primary.get_children(False))
                                       print("DEBUG: Reopened project basic access confirmed.")
                                       return recheck_primary # SUCCESS CASE 2: Successfully opened/reopened
                                   except Exception as access_err_reopen:
                                        print("WARN: Reopened project (%s) basic access check failed: %s." % (normalized_target_path, access_err_reopen))
                                        # traceback.print_exc() # Optional
                                        # Allow retry loop to continue
                              else:
                                   print("WARN: Different project is primary after reopening! Expected '%s', got '%s'." % (normalized_target_path, recheck_path))
                                   # Allow retry loop to continue, maybe it fixes itself
                         else:
                               print("WARN: No primary project found after reopening attempt %d!" % (attempt+1))
                               # Allow retry loop to continue

                except Exception as open_err:
                     # Catch errors during the open call itself
                     print("ERROR: Exception during projects.open call on attempt %d: %s" % (attempt + 1, open_err))
                     traceback.print_exc() # Crucial for diagnosing open failures
                     # Allow retry loop to continue

            except Exception as outer_open_err:
                 # Catch errors in the flag setup etc.
                 print("ERROR: Unexpected error during open setup/logic attempt %d: %s" % (attempt + 1, outer_open_err))
                 traceback.print_exc()

        # If we didn't return successfully in this attempt, wait before retrying
        if attempt < MAX_RETRIES - 1:
            print("DEBUG: Ensure project attempt %d did not succeed. Waiting %f seconds..." % (attempt + 1, RETRY_DELAY))
            time.sleep(RETRY_DELAY)
        else: # Last attempt failed
             print("ERROR: Failed all ensure_project_open attempts for %s." % normalized_target_path)


    # If all retries fail after the loop
    raise RuntimeError("Failed to ensure project '%s' is open and accessible after %d attempts." % (target_project_path, MAX_RETRIES))
# --- End of function ---

# Placeholder for the project file path (must be set in scripts using this snippet)
PROJECT_FILE_PATH = r"{PROJECT_FILE_PATH}"
`;

    const CHECK_STATUS_SCRIPT = `
import sys, scriptengine as script_engine, os, traceback
project_open = False; project_name = "No project open"; project_path = "N/A"; scripting_ok = False
try:
    scripting_ok = True; primary_project = script_engine.projects.primary
    if primary_project:
        project_open = True
        try:
            project_path = os.path.normcase(os.path.abspath(primary_project.path))
            try:
                 project_name = primary_project.get_name() # Might fail
                 if not project_name: project_name = "Unnamed (path: %s)" % os.path.basename(project_path)
            except: project_name = "Unnamed (path: %s)" % os.path.basename(project_path)
        except Exception as e_path: project_path = "N/A (Error: %s)" % e_path; project_name = "Unnamed (Path Error)"
    print("Project Open: %s" % project_open); print("Project Name: %s" % project_name)
    print("Project Path: %s" % project_path); print("Scripting OK: %s" % scripting_ok)
    print("SCRIPT_SUCCESS: Status check complete."); sys.exit(0)
except Exception as e:
    error_message = "Error during status check: %s" % e
    print(error_message); print("Scripting OK: False")
    # traceback.print_exc() # Optional traceback
    print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

    const OPEN_PROJECT_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
try:
    project = ensure_project_open(PROJECT_FILE_PATH)
    # Get name from object if possible, otherwise use path basename
    proj_name = "Unknown"
    try:
        if project: proj_name = project.get_name() or os.path.basename(PROJECT_FILE_PATH)
        else: proj_name = os.path.basename(PROJECT_FILE_PATH) + " (ensure_project_open returned None?)"
    except Exception:
        proj_name = os.path.basename(PROJECT_FILE_PATH) + " (name retrieval failed)"
    print("Project Opened: %s" % proj_name)
    print("SCRIPT_SUCCESS: Project opened successfully.")
    sys.exit(0)
except Exception as e:
    error_message = "Error opening project %s: %s" % (PROJECT_FILE_PATH, e)
    print(error_message)
    traceback.print_exc()
    print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

    const CREATE_PROJECT_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, shutil, time, traceback
# Placeholders
TEMPLATE_PROJECT_PATH = r'{TEMPLATE_PROJECT_PATH}' # Path to Standard.project
PROJECT_FILE_PATH = r'{PROJECT_FILE_PATH}'    # Path for the new project (Target Path)
try:
    print("DEBUG: Python script create_project (copy from template):")
    print("DEBUG:   Template Source = %s" % TEMPLATE_PROJECT_PATH)
    print("DEBUG:   Target Path = %s" % PROJECT_FILE_PATH)
    if not PROJECT_FILE_PATH: raise ValueError("Target project file path empty.")
    if not TEMPLATE_PROJECT_PATH: raise ValueError("Template project file path empty.")
    if not os.path.exists(TEMPLATE_PROJECT_PATH): raise IOError("Template project file not found: %s" % TEMPLATE_PROJECT_PATH)

    # 1. Copy the template project file to the new location
    target_dir = os.path.dirname(PROJECT_FILE_PATH)
    if not os.path.exists(target_dir): print("DEBUG: Creating target directory: %s" % target_dir); os.makedirs(target_dir)
    # Check if target file already exists
    if os.path.exists(PROJECT_FILE_PATH): print("WARN: Target project file already exists, overwriting: %s" % PROJECT_FILE_PATH)

    print("DEBUG: Copying '%s' to '%s'..." % (TEMPLATE_PROJECT_PATH, PROJECT_FILE_PATH))
    shutil.copy2(TEMPLATE_PROJECT_PATH, PROJECT_FILE_PATH) # copy2 preserves metadata
    print("DEBUG: File copy complete.")

    # 2. Open the newly copied project file
    print("DEBUG: Opening the copied project: %s" % PROJECT_FILE_PATH)
    # Set flags for silent opening
    update_mode = script_engine.VersionUpdateFlags.NoUpdates | script_engine.VersionUpdateFlags.SilentMode
    # try:
    #     update_mode = script_engine.VersionUpdateFlags.NoUpdates | script_engine.VersionUpdateFlags.SilentMode
    # except AttributeError:
    #     print("WARN: VersionUpdateFlags not found, using integer flags for open (1 | 2 = 3).")
    #     update_mode = 3

    project = script_engine.projects.open(PROJECT_FILE_PATH, update_flags=update_mode)
    print("DEBUG: script_engine.projects.open returned: %s" % project)
    if project:
        print("DEBUG: Pausing briefly after open...")
        time.sleep(1.0) # Allow CODESYS to potentially initialize things
        try:
            print("DEBUG: Explicitly saving project after opening copy...")
            project.save();
            print("DEBUG: Project save after opening copy succeeded.")
        except Exception as save_err:
             print("WARN: Explicit save after opening copy failed: %s" % save_err)
             # Decide if this is critical - maybe not, but good to know.
        print("Project Created from Template Copy at: %s" % PROJECT_FILE_PATH)
        print("SCRIPT_SUCCESS: Project copied from template and opened successfully.")
        sys.exit(0)
    else:
        error_message = "Failed to open project copy %s after copying template %s. projects.open returned None." % (PROJECT_FILE_PATH, TEMPLATE_PROJECT_PATH)
        print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error creating project '%s' from template '%s': %s\\n%s" % (PROJECT_FILE_PATH, TEMPLATE_PROJECT_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: Error copying/opening template: %s" % e); sys.exit(1)
`;

    const SAVE_PROJECT_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
try:
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    # Get name from object if possible, otherwise use path basename
    project_name = "Unknown"
    try:
        if primary_project: project_name = primary_project.get_name() or os.path.basename(PROJECT_FILE_PATH)
        else: project_name = os.path.basename(PROJECT_FILE_PATH) + " (ensure_project_open returned None?)"
    except Exception:
        project_name = os.path.basename(PROJECT_FILE_PATH) + " (name retrieval failed)"

    print("DEBUG: Saving project: %s (%s)" % (project_name, PROJECT_FILE_PATH))
    primary_project.save()
    print("DEBUG: project.save() executed.")
    print("Project Saved: %s" % project_name)
    print("SCRIPT_SUCCESS: Project saved successfully.")
    sys.exit(0)
except Exception as e:
    error_message = "Error saving project %s: %s" % (PROJECT_FILE_PATH, e)
    print(error_message)
    traceback.print_exc()
    print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

    const FIND_OBJECT_BY_PATH_PYTHON_SNIPPET = `
import traceback
# --- Find object by path function ---
def find_object_by_path_robust(start_node, full_path, target_type_name="object"):
    print("DEBUG: Finding %s by path: '%s'" % (target_type_name, full_path))
    normalized_path = full_path.replace('\\\\', '/').strip('/')
    path_parts = normalized_path.split('/')
    if not path_parts:
        print("ERROR: Path is empty.")
        return None

    # Determine the actual starting node (project or application)
    project = start_node # Assume start_node is project initially
    if not hasattr(start_node, 'active_application') and hasattr(start_node, 'project'):
         # If start_node is not project but has project ref (e.g., an application), get the project
         try: project = start_node.project
         except Exception as proj_ref_err:
             print("WARN: Could not get project reference from start_node: %s" % proj_ref_err)
             # Proceed assuming start_node might be the project anyway or search fails

    # Try to get the application object robustly if we think we have the project
    app = None
    if hasattr(project, 'active_application'):
        try: app = project.active_application
        except Exception: pass # Ignore errors getting active app
        if not app:
            try:
                 apps = project.find("Application", True) # Search recursively
                 if apps: app = apps[0]
            except Exception: pass

    # Check if the first path part matches the application name
    app_name_lower = ""
    if app:
        try: app_name_lower = (app.get_name() or "application").lower()
        except Exception: app_name_lower = "application" # Fallback

    # Decide where to start the traversal
    current_obj = start_node # Default to the node passed in
    if hasattr(project, 'active_application'): # Only adjust if start_node was likely the project
        if app and path_parts[0].lower() == app_name_lower:
             print("DEBUG: Path starts with Application name '%s'. Beginning search there." % path_parts[0])
             current_obj = app
             path_parts = path_parts[1:] # Consume the app name part
             # If path was *only* the application name
             if not path_parts:
                 print("DEBUG: Target path is the Application object itself.")
                 return current_obj
        else:
            print("DEBUG: Path does not start with Application name. Starting search from project root.")
            current_obj = project # Start search from the project root
    else:
         print("DEBUG: Starting search from originally provided node.")


    # Traverse the remaining path parts
    parent_path_str = getattr(current_obj, 'get_name', lambda: str(current_obj))() # Safer name getting

    for i, part_name in enumerate(path_parts):
        is_last_part = (i == len(path_parts) - 1)
        print("DEBUG: Searching for part [%d/%d]: '%s' under '%s'" % (i+1, len(path_parts), part_name, parent_path_str))
        found_in_parent = None
        try:
            # Prioritize non-recursive find for direct children
            children_of_current = current_obj.get_children(False)
            print("DEBUG: Found %d direct children under '%s'." % (len(children_of_current), parent_path_str))
            for child in children_of_current:
                 child_name = getattr(child, 'get_name', lambda: None)() # Safer name getting
                 # print("DEBUG: Checking child: '%s'" % child_name) # Verbose
                 if child_name == part_name:
                     found_in_parent = child
                     print("DEBUG: Found direct child matching '%s'." % part_name)
                     break # Found direct child, stop searching children

            # If not found directly, AND it's the last part, try recursive find from current parent
            if not found_in_parent and is_last_part:
                 print("DEBUG: Direct find failed for last part '%s'. Trying recursive find under '%s'." % (part_name, parent_path_str))
                 found_recursive_list = current_obj.find(part_name, True) # Recursive find
                 if found_recursive_list:
                     # Maybe add a check here if multiple are found?
                     found_in_parent = found_recursive_list[0] # Take the first match
                     print("DEBUG: Found last part '%s' recursively." % part_name)
                 else:
                     print("DEBUG: Recursive find also failed for last part '%s'." % part_name)

            # Update current object if found
            if found_in_parent:
                current_obj = found_in_parent
                parent_path_str = getattr(current_obj, 'get_name', lambda: part_name)() # Safer name getting
                print("DEBUG: Stepped into '%s'." % parent_path_str)
            else:
                # If not found at any point, the path is invalid from this parent
                print("ERROR: Path part '%s' not found under '%s'." % (part_name, parent_path_str))
                return None # Path broken

        except Exception as find_err:
            print("ERROR: Exception while searching for '%s' under '%s': %s" % (part_name, parent_path_str, find_err))
            traceback.print_exc()
            return None # Error during search

    # Final verification (optional but recommended): Check if the found object's name matches the last part
    final_expected_name = full_path.split('/')[-1]
    found_final_name = getattr(current_obj, 'get_name', lambda: None)() # Safer name getting

    if found_final_name == final_expected_name:
        print("DEBUG: Final %s found and name verified for path '%s': %s" % (target_type_name, full_path, found_final_name))
        return current_obj
    else:
        print("ERROR: Traversal ended on object '%s' but expected final name was '%s'." % (found_final_name, final_expected_name))
        return None # Name mismatch implies target not found as expected

# --- End of find object function ---
`;

    const CREATE_POU_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
${FIND_OBJECT_BY_PATH_PYTHON_SNIPPET}
POU_NAME = "{POU_NAME}"; POU_TYPE_STR = "{POU_TYPE_STR}"; IMPL_LANGUAGE_STR = "{IMPL_LANGUAGE_STR}"; PARENT_PATH_REL = "{PARENT_PATH}"
pou_type_map = { "Program": script_engine.PouType.Program, "FunctionBlock": script_engine.PouType.FunctionBlock, "Function": script_engine.PouType.Function }
# Map common language names to ImplementationLanguages attributes if needed (optional, None usually works)
# lang_map = { "ST": script_engine.ImplementationLanguage.st, ... }

try:
    print("DEBUG: create_pou script: Name='%s', Type='%s', Lang='%s', ParentPath='%s', Project='%s'" % (POU_NAME, POU_TYPE_STR, IMPL_LANGUAGE_STR, PARENT_PATH_REL, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not POU_NAME: raise ValueError("POU name empty.")
    if not PARENT_PATH_REL: raise ValueError("Parent path empty.")

    # Resolve POU Type Enum
    pou_type_enum = pou_type_map.get(POU_TYPE_STR)
    if not pou_type_enum: raise ValueError("Invalid POU type string: %s. Use Program, FunctionBlock, or Function." % POU_TYPE_STR)

    # Find parent object using the robust function
    parent_object = find_object_by_path_robust(primary_project, PARENT_PATH_REL, "parent container")
    if not parent_object: raise ValueError("Parent object not found for path: %s" % PARENT_PATH_REL)

    parent_name = getattr(parent_object, 'get_name', lambda: str(parent_object))()
    print("DEBUG: Using parent object: %s (Type: %s)" % (parent_name, type(parent_object).__name__))

    # Check if parent object supports creating POUs (should implement ScriptIecLanguageObjectContainer)
    if not hasattr(parent_object, 'create_pou'):
        raise TypeError("Parent object '%s' of type %s does not support create_pou." % (parent_name, type(parent_object).__name__))

    # Set language GUID to None (let CODESYS default based on parent/settings)
    lang_guid = None
    print("DEBUG: Setting language to None (will use default).")
    # Example if mapping language string: lang_guid = lang_map.get(IMPL_LANGUAGE_STR, None)

    print("DEBUG: Calling parent_object.create_pou: Name='%s', Type=%s, Lang=%s" % (POU_NAME, pou_type_enum, lang_guid))

    # Call create_pou using keyword arguments
    new_pou = parent_object.create_pou(
        name=POU_NAME,
        type=pou_type_enum,
        language=lang_guid # Pass None
    )

    print("DEBUG: parent_object.create_pou returned: %s" % new_pou)
    if new_pou:
        new_pou_name = getattr(new_pou, 'get_name', lambda: POU_NAME)()
        print("DEBUG: POU object created: %s" % new_pou_name)

        # --- SAVE THE PROJECT TO PERSIST THE NEW POU ---
        try:
            print("DEBUG: Saving Project...")
            primary_project.save() # Save the overall project file
            print("DEBUG: Project saved successfully after POU creation.")
        except Exception as save_err:
            print("ERROR: Failed to save Project after POU creation: %s" % save_err)
            detailed_error = traceback.format_exc()
            error_message = "Error saving Project after creating POU '%s': %s\\n%s" % (new_pou_name, save_err, detailed_error)
            print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
        # --- END SAVING ---

        print("POU Created: %s" % new_pou_name); print("Type: %s" % POU_TYPE_STR); print("Language: %s (Defaulted)" % IMPL_LANGUAGE_STR); print("Parent Path: %s" % PARENT_PATH_REL)
        print("SCRIPT_SUCCESS: POU created successfully."); sys.exit(0)
    else:
        error_message = "Failed to create POU '%s'. create_pou returned None." % POU_NAME; print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error creating POU '%s' in project '%s': %s\\n%s" % (POU_NAME, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: Error creating POU '%s': %s" % (POU_NAME, e)); sys.exit(1)
`;

    // Erzeugt eine ECHTE Global Variable List (GVL) als eigenes Objekt via

    // ScriptIecLanguageObjectContainer.create_gvl(name). Behebt den Stolperstein,

    // dass der Agent mangels GVL-Werkzeug bisher eine GVL faelschlich als PROGRAM

    // anlegte (VAR_GLOBAL in einem Programm ist ungueltig). Optional wird die

    // vollstaendige textuelle Deklaration (VAR_GLOBAL ... END_VAR) gesetzt.

    const CREATE_GVL_SCRIPT_TEMPLATE = `

import sys, scriptengine as script_engine, os, traceback

${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}

${FIND_OBJECT_BY_PATH_PYTHON_SNIPPET}

GVL_NAME = "{GVL_NAME}"; PARENT_PATH_REL = "{PARENT_PATH}"

DECLARATION_CONTENT = """{DECLARATION_CONTENT}"""

SET_DECL = {SET_DECL}



try:

    print("DEBUG: create_gvl script: Name='%s', ParentPath='%s', Project='%s'" % (GVL_NAME, PARENT_PATH_REL, PROJECT_FILE_PATH))

    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    if not GVL_NAME: raise ValueError("GVL name empty.")

    if not PARENT_PATH_REL: raise ValueError("Parent path empty.")



    parent_object = find_object_by_path_robust(primary_project, PARENT_PATH_REL, "parent container")

    if not parent_object: raise ValueError("Parent object not found for path: %s" % PARENT_PATH_REL)

    parent_name = getattr(parent_object, 'get_name', lambda: str(parent_object))()

    print("DEBUG: Using parent object: %s (Type: %s)" % (parent_name, type(parent_object).__name__))



    if not hasattr(parent_object, 'create_gvl'):

        raise TypeError("Parent object '%s' of type %s does not support create_gvl." % (parent_name, type(parent_object).__name__))



    # Idempotenz: existiert direkt unter dem Parent bereits eine GVL des Namens, wird sie wiederverwendet.

    new_gvl = None

    try:

        for ch in parent_object.get_children(False):

            if getattr(ch, 'get_name', lambda: None)() == GVL_NAME:

                new_gvl = ch; print("DEBUG: GVL '%s' existiert bereits, wird wiederverwendet." % GVL_NAME); break

    except Exception as scan_err:

        print("DEBUG: Kind-Scan uebersprungen: %s" % scan_err)



    if new_gvl is None:

        print("DEBUG: Calling parent_object.create_gvl('%s')" % GVL_NAME)

        new_gvl = parent_object.create_gvl(GVL_NAME)



    if not new_gvl:

        error_message = "Failed to create GVL '%s'. create_gvl returned None." % GVL_NAME

        print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)



    gvl_name_actual = getattr(new_gvl, 'get_name', lambda: GVL_NAME)()



    # Optional die vollstaendige textuelle Deklaration setzen (ganzer VAR_GLOBAL-Block).

    if SET_DECL:

        if hasattr(new_gvl, 'textual_declaration') and new_gvl.textual_declaration and hasattr(new_gvl.textual_declaration, 'replace'):

            new_gvl.textual_declaration.replace(DECLARATION_CONTENT)

            print("DEBUG: GVL-Deklaration gesetzt.")

        else:

            print("WARN: GVL '%s' hat keine beschreibbare textual_declaration; Deklaration uebersprungen." % gvl_name_actual)



    primary_project.save()

    print("GVL Created: %s" % gvl_name_actual); print("Parent Path: %s" % PARENT_PATH_REL)

    print("SCRIPT_SUCCESS: GVL created successfully."); sys.exit(0)

except Exception as e:

    detailed_error = traceback.format_exc()

    error_message = "Error creating GVL '%s' in project '%s': %s\\n%s" % (GVL_NAME, PROJECT_FILE_PATH, e, detailed_error)

    print(error_message); print("SCRIPT_ERROR: Error creating GVL '%s': %s" % (GVL_NAME, e)); sys.exit(1)

`;

    // Fuegt dem Projekt eine Bibliotheks-Referenz hinzu (Library Manager add_library),
    // damit Katalog-Bausteine wie TYP_IDF1/TYP_BIN/TYP_AIN aus z.B. Grundfunktionen.library
    // aufloesen. Bibliothek wird per Name aus dem Repository geholt oder per .library-Datei
    // installiert. Baustein fuer vorlagenfreies Scaffolding.
    const ADD_LIBRARY_REFERENCE_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
LIB_NAME = "{LIB_NAME}"
LIB_FILEPATH = """{LIB_FILEPATH}"""
AS_PLACEHOLDER = {AS_PLACEHOLDER}
PLACEHOLDER_NAME = "{PLACEHOLDER_NAME}"

try:
    print("DEBUG: add_library_reference: name='%s', file='%s', project='%s'" % (LIB_NAME, LIB_FILEPATH, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    libmgr = getattr(script_engine, 'library_manager', None)
    if libmgr is None:
        raise RuntimeError("scriptengine has no 'library_manager' in scope.")

    # 1) ManagedLib beschaffen: erst per Name aus den Repositories, sonst per Datei installieren.
    managed = None
    if LIB_NAME:
        try:
            managed = libmgr.get_library(LIB_NAME, None)
        except Exception as ge:
            print("DEBUG: get_library('%s') failed: %s" % (LIB_NAME, ge))
    if managed is None and LIB_FILEPATH:
        if not os.path.exists(LIB_FILEPATH):
            raise ValueError("Library file not found: %s" % LIB_FILEPATH)
        print("DEBUG: installing library from file: %s" % LIB_FILEPATH)
        try:
            managed = libmgr.install_library(LIB_FILEPATH, None, False)
        except Exception as ie:
            print("DEBUG: install_library failed (may already be installed): %s" % ie)
        if managed is None and LIB_NAME:
            managed = libmgr.get_library(LIB_NAME, None)
    if managed is None:
        raise ValueError("Could not resolve a managed library (name='%s', file='%s'). Provide an installed libraryName or a valid libraryFilePath." % (LIB_NAME, LIB_FILEPATH))
    disp = getattr(managed, 'displayname', LIB_NAME) or LIB_NAME
    print("DEBUG: resolved managed library: %s" % disp)

    # 2) Library-Manager-Objekt im Projekt finden (implementiert add_library/get_libraries).
    libman = None
    for o in primary_project.get_children(True):
        if hasattr(o, 'add_library') and hasattr(o, 'get_libraries'):
            libman = o; break
    if libman is None:
        raise RuntimeError("No Library Manager object found in project (needs an Application with a Library Manager).")

    # 3) Idempotenz: schon referenziert?
    already = False
    try:
        for e in list(libman.get_libraries(False)):
            if LIB_NAME and LIB_NAME.lower() in str(e).lower():
                already = True; break
    except Exception as le:
        print("DEBUG: get_libraries failed: %s" % le)

    if already:
        print("DEBUG: library '%s' already referenced; nothing to do." % LIB_NAME)
    elif AS_PLACEHOLDER:
        print("DEBUG: add_placeholder('%s', managed)" % (PLACEHOLDER_NAME or disp))
        libman.add_placeholder(PLACEHOLDER_NAME or disp, managed)
    else:
        print("DEBUG: add_library(managed)")
        libman.add_library(managed)

    primary_project.save()
    print("Library referenced: %s" % disp)
    print("SCRIPT_SUCCESS: library reference added."); sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error add_library_reference in '%s': %s\\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % e); sys.exit(1)
`;

    const SET_POU_CODE_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
${FIND_OBJECT_BY_PATH_PYTHON_SNIPPET}
POU_FULL_PATH = "{POU_FULL_PATH}" # Expecting format like "Application/MyPOU" or "Folder/SubFolder/MyPOU"
DECLARATION_CONTENT = """{DECLARATION_CONTENT}"""
IMPLEMENTATION_CONTENT = """{IMPLEMENTATION_CONTENT}"""
SET_DECL = {SET_DECL}
SET_IMPL = {SET_IMPL}

try:
    print("DEBUG: set_pou_code script: POU_FULL_PATH='%s', Project='%s'" % (POU_FULL_PATH, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not POU_FULL_PATH: raise ValueError("POU full path empty.")

    # Find the target POU/Method/Property object
    target_object = find_object_by_path_robust(primary_project, POU_FULL_PATH, "target object")
    if not target_object: raise ValueError("Target object not found using path: %s" % POU_FULL_PATH)

    target_name = getattr(target_object, 'get_name', lambda: POU_FULL_PATH)()
    print("DEBUG: Found target object: %s" % target_name)

    # --- Set Declaration Part ---
    declaration_updated = False
    # Only touch the declaration when the caller actually provided declarationCode.
    # (An omitted declaration must NOT be replaced with "" — that would wipe e.g. 'PROGRAM PLC_PRG'.)
    if SET_DECL:
        if hasattr(target_object, 'textual_declaration'):
            decl_obj = target_object.textual_declaration
            if decl_obj and hasattr(decl_obj, 'replace'):
                try:
                    print("DEBUG: Accessing textual_declaration...")
                    decl_obj.replace(DECLARATION_CONTENT)
                    print("DEBUG: Set declaration text using replace().")
                    declaration_updated = True
                except Exception as decl_err:
                    print("ERROR: Failed to set declaration text: %s" % decl_err)
                    traceback.print_exc() # Print stack trace for detailed error
            else:
                 print("WARN: Target '%s' textual_declaration attribute is None or does not have replace(). Skipping declaration update." % target_name)
        else:
            print("WARN: Target '%s' does not have textual_declaration attribute. Skipping declaration update." % target_name)
    else:
         print("DEBUG: Declaration content not provided or is None. Skipping declaration update.")


    # --- Set Implementation Part ---
    implementation_updated = False
    if SET_IMPL:
        if hasattr(target_object, 'textual_implementation'):
            impl_obj = target_object.textual_implementation
            if impl_obj and hasattr(impl_obj, 'replace'):
                try:
                    print("DEBUG: Accessing textual_implementation...")
                    impl_obj.replace(IMPLEMENTATION_CONTENT)
                    print("DEBUG: Set implementation text using replace().")
                    implementation_updated = True
                except Exception as impl_err:
                     print("ERROR: Failed to set implementation text: %s" % impl_err)
                     traceback.print_exc() # Print stack trace for detailed error
            else:
                 print("WARN: Target '%s' textual_implementation attribute is None or does not have replace(). Skipping implementation update." % target_name)
        else:
            print("WARN: Target '%s' does not have textual_implementation attribute. Skipping implementation update." % target_name)
    else:
        print("DEBUG: Implementation content not provided or is None. Skipping implementation update.")


    # --- SAVE THE PROJECT TO PERSIST THE CODE CHANGE ---
    # Only save if something was actually updated to avoid unnecessary saves
    if declaration_updated or implementation_updated:
        try:
            print("DEBUG: Saving Project (after code change)...")
            primary_project.save() # Save the overall project file
            print("DEBUG: Project saved successfully after code change.")
        except Exception as save_err:
            print("ERROR: Failed to save Project after setting code: %s" % save_err)
            detailed_error = traceback.format_exc()
            error_message = "Error saving Project after code change for '%s': %s\\n%s" % (target_name, save_err, detailed_error)
            print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
    else:
         print("DEBUG: No code parts were updated, skipping project save.")
    # --- END SAVING ---

    print("Code Set For: %s" % target_name)
    print("Path: %s" % POU_FULL_PATH)
    print("SCRIPT_SUCCESS: Declaration and/or implementation set successfully."); sys.exit(0)

except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error setting code for object '%s' in project '%s': %s\\n%s" % (POU_FULL_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

    const CREATE_PROPERTY_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
${FIND_OBJECT_BY_PATH_PYTHON_SNIPPET}
PARENT_POU_FULL_PATH = "{PARENT_POU_FULL_PATH}" # e.g., "Application/MyFB"
PROPERTY_NAME = "{PROPERTY_NAME}"
PROPERTY_TYPE = "{PROPERTY_TYPE}"
# Optional: Language for Getter/Setter (usually defaults to ST)
# LANG_GUID_STR = "{LANG_GUID_STR}" # Example if needed

try:
    print("DEBUG: create_property script: ParentPOU='%s', Name='%s', Type='%s', Project='%s'" % (PARENT_POU_FULL_PATH, PROPERTY_NAME, PROPERTY_TYPE, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not PARENT_POU_FULL_PATH: raise ValueError("Parent POU full path empty.")
    if not PROPERTY_NAME: raise ValueError("Property name empty.")
    if not PROPERTY_TYPE: raise ValueError("Property type empty.")

    # Find the parent POU object
    parent_pou_object = find_object_by_path_robust(primary_project, PARENT_POU_FULL_PATH, "parent POU")
    if not parent_pou_object: raise ValueError("Parent POU object not found: %s" % PARENT_POU_FULL_PATH)

    parent_pou_name = getattr(parent_pou_object, 'get_name', lambda: PARENT_POU_FULL_PATH)()
    print("DEBUG: Found Parent POU object: %s" % parent_pou_name)

    # Check if parent object supports creating properties (should implement ScriptIecLanguageMemberContainer)
    if not hasattr(parent_pou_object, 'create_property'):
         raise TypeError("Parent object '%s' of type %s does not support create_property." % (parent_pou_name, type(parent_pou_object).__name__))

    # Default language to None (usually ST)
    lang_guid = None
    print("DEBUG: Calling create_property: Name='%s', Type='%s', Lang=%s" % (PROPERTY_NAME, PROPERTY_TYPE, lang_guid))

    # Call the create_property method ON THE PARENT POU
    new_property_object = parent_pou_object.create_property(
        name=PROPERTY_NAME,
        return_type=PROPERTY_TYPE,
        language=lang_guid # Pass None to use default
    )

    if new_property_object:
        new_prop_name = getattr(new_property_object, 'get_name', lambda: PROPERTY_NAME)()
        print("DEBUG: Property object created: %s" % new_prop_name)

        # --- SAVE THE PROJECT TO PERSIST THE NEW PROPERTY OBJECT ---
        try:
            print("DEBUG: Saving Project (after property creation)...")
            primary_project.save()
            print("DEBUG: Project saved successfully after property creation.")
        except Exception as save_err:
            print("ERROR: Failed to save Project after creating property: %s" % save_err)
            detailed_error = traceback.format_exc()
            error_message = "Error saving Project after creating property '%s': %s\\n%s" % (PROPERTY_NAME, save_err, detailed_error)
            print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
        # --- END SAVING ---

        print("Property Created: %s" % new_prop_name)
        print("Parent POU: %s" % PARENT_POU_FULL_PATH)
        print("Type: %s" % PROPERTY_TYPE)
        print("SCRIPT_SUCCESS: Property created successfully."); sys.exit(0)
    else:
         error_message = "Failed to create property '%s' under '%s'. create_property returned None." % (PROPERTY_NAME, parent_pou_name)
         print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)

except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error creating property '%s' under POU '%s' in project '%s': %s\\n%s" % (PROPERTY_NAME, PARENT_POU_FULL_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

    const CREATE_METHOD_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
${FIND_OBJECT_BY_PATH_PYTHON_SNIPPET}
PARENT_POU_FULL_PATH = "{PARENT_POU_FULL_PATH}" # e.g., "Application/MyFB"
METHOD_NAME = "{METHOD_NAME}"
RETURN_TYPE = "{RETURN_TYPE}" # Can be empty string for no return type
# Optional: Language
# LANG_GUID_STR = "{LANG_GUID_STR}" # Example if needed

try:
    print("DEBUG: create_method script: ParentPOU='%s', Name='%s', ReturnType='%s', Project='%s'" % (PARENT_POU_FULL_PATH, METHOD_NAME, RETURN_TYPE, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not PARENT_POU_FULL_PATH: raise ValueError("Parent POU full path empty.")
    if not METHOD_NAME: raise ValueError("Method name empty.")
    # RETURN_TYPE can be empty

    # Find the parent POU object
    parent_pou_object = find_object_by_path_robust(primary_project, PARENT_POU_FULL_PATH, "parent POU")
    if not parent_pou_object: raise ValueError("Parent POU object not found: %s" % PARENT_POU_FULL_PATH)

    parent_pou_name = getattr(parent_pou_object, 'get_name', lambda: PARENT_POU_FULL_PATH)()
    print("DEBUG: Found Parent POU object: %s" % parent_pou_name)

     # Check if parent object supports creating methods (should implement ScriptIecLanguageMemberContainer)
    if not hasattr(parent_pou_object, 'create_method'):
         raise TypeError("Parent object '%s' of type %s does not support create_method." % (parent_pou_name, type(parent_pou_object).__name__))

    # Default language to None (usually ST)
    lang_guid = None
    # Use None if RETURN_TYPE is empty string, otherwise use the string
    actual_return_type = RETURN_TYPE if RETURN_TYPE else None
    print("DEBUG: Calling create_method: Name='%s', ReturnType=%s, Lang=%s" % (METHOD_NAME, actual_return_type, lang_guid))

    # Call the create_method method ON THE PARENT POU
    new_method_object = parent_pou_object.create_method(
        name=METHOD_NAME,
        return_type=actual_return_type,
        language=lang_guid # Pass None to use default
    )

    if new_method_object:
        new_meth_name = getattr(new_method_object, 'get_name', lambda: METHOD_NAME)()
        print("DEBUG: Method object created: %s" % new_meth_name)

        # --- SAVE THE PROJECT TO PERSIST THE NEW METHOD OBJECT ---
        try:
            print("DEBUG: Saving Project (after method creation)...")
            primary_project.save()
            print("DEBUG: Project saved successfully after method creation.")
        except Exception as save_err:
            print("ERROR: Failed to save Project after creating method: %s" % save_err)
            detailed_error = traceback.format_exc()
            error_message = "Error saving Project after creating method '%s': %s\\n%s" % (METHOD_NAME, save_err, detailed_error)
            print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
        # --- END SAVING ---

        print("Method Created: %s" % new_meth_name)
        print("Parent POU: %s" % PARENT_POU_FULL_PATH)
        print("Return Type: %s" % (RETURN_TYPE if RETURN_TYPE else "(None)"))
        print("SCRIPT_SUCCESS: Method created successfully."); sys.exit(0)
    else:
         error_message = "Failed to create method '%s' under '%s'. create_method returned None." % (METHOD_NAME, parent_pou_name)
         print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)

except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error creating method '%s' under POU '%s' in project '%s': %s\\n%s" % (METHOD_NAME, PARENT_POU_FULL_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

    const COMPILE_PROJECT_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
try:
    print("DEBUG: compile_project script: Project='%s'" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_name = os.path.basename(PROJECT_FILE_PATH)
    target_app = None
    app_name = "N/A"

    # Try getting active application first
    try:
        target_app = primary_project.active_application
        if target_app:
            app_name = getattr(target_app, 'get_name', lambda: "Unnamed App (Active)")()
            print("DEBUG: Found active application: %s" % app_name)
    except Exception as active_err:
        print("WARN: Could not get active application: %s. Searching..." % active_err)

    # If no active app, search for the first one
    if not target_app:
        print("DEBUG: Searching for first compilable application...")
        apps = []
        try:
             # Search recursively through all project objects
             all_children = primary_project.get_children(True)
             for child in all_children:
                  # Check using the marker property and if build method exists
                  if hasattr(child, 'is_application') and child.is_application and hasattr(child, 'build'):
                       app_name_found = getattr(child, 'get_name', lambda: "Unnamed App")()
                       print("DEBUG: Found potential application object: %s" % app_name_found)
                       apps.append(child)
                       break # Take the first one found
        except Exception as find_err: print("WARN: Error finding application object: %s" % find_err)

        if not apps: raise RuntimeError("No compilable application found in project '%s'" % project_name)
        target_app = apps[0]
        app_name = getattr(target_app, 'get_name', lambda: "Unnamed App (First Found)")()
        print("WARN: Compiling first found application: %s" % app_name)

    print("DEBUG: Calling build() on app '%s'..." % app_name)
    if not hasattr(target_app, 'build'):
         raise TypeError("Selected object '%s' is not an application or doesn't support build()." % app_name)

    # Execute the build
    target_app.build();
    print("DEBUG: Build command executed for application '%s'." % app_name)

    # --- Evaluate build results via the message store ---
    # build() explicitly supports reading compiler messages afterwards via
    # System.get_message_objects(). Severity bit flags: FatalError=1, Error=2, Warning=4.
    errors = 0
    warnings = 0
    detail_lines = []
    messages_read = False
    query_failed = False
    try:
        _sys = None
        try:
            _sys = system
        except NameError:
            _sys = getattr(script_engine, 'system', None)
        if _sys is None:
            raise RuntimeError("Scripting 'system' object not available.")

        def _msg_text(m):
            t = getattr(m, 'text', None)
            return t if t else str(m)

        # Severity is an enum; the API rejects raw ints for the severities filter.
        sev_enum = getattr(script_engine, 'Severity', None)
        if sev_enum is None:
            raise RuntimeError("Severity enum not available.")
        error_severities = [sev_enum.FatalError, sev_enum.Error]

        # Detect compile errors headless. Plain build() does NOT emit compile errors to
        # the scripting message store on this --runscript setup. create_boot_application()
        # forces a full precompile of the code that enters the boot application (all
        # referenced/reachable code) and writes errors to the fixed Build category, which
        # we then read. NOTE: purely UNREFERENCED objects are not part of the boot app and
        # are therefore not checked here (same scope as an actual PLC download).
        compile_cat = None
        try:
            compile_cat = Guid("{97F48D64-A2A3-4856-B640-75C046E37EA9}")
        except Exception:
            try:
                from System import Guid as _Guid
                compile_cat = _Guid("{97F48D64-A2A3-4856-B640-75C046E37EA9}")
            except Exception as ge:
                print("DEBUG: compile-category Guid failed: %s" % ge)

        if compile_cat is not None:
            try:
                _sys.clear_messages(compile_cat)
            except Exception as clr:
                print("DEBUG: clear_messages failed: %s" % clr)

        import tempfile as _tf
        _boot = os.path.join(_tf.gettempdir(), "codesys_boot_check.app")
        try:
            target_app.create_boot_application(_boot)
        except Exception as cba:
            # NullReference is expected headless (boot-file generation needs a target);
            # the precompile that runs first has already populated the Build category.
            print("DEBUG: create_boot_application: %s" % cba)

        if compile_cat is not None:
            try:
                err_mask = sev_enum.FatalError | sev_enum.Error
                for m in _sys.get_message_objects(compile_cat, err_mask):
                    errors += 1
                    detail_lines.append("ERROR: %s%s: %s" % (getattr(m, 'prefix', '') or '', getattr(m, 'number', '') or '', _msg_text(m)))
                for m in _sys.get_message_objects(compile_cat, sev_enum.Warning):
                    warnings += 1
                    detail_lines.append("WARNING: %s%s: %s" % (getattr(m, 'prefix', '') or '', getattr(m, 'number', '') or '', _msg_text(m)))
                messages_read = True
            except Exception as rderr:
                print("DEBUG: compile-category read failed: %s" % rderr)
                messages_read = False
    except Exception as msg_err:
        print("WARN: Could not read build messages from store: %s" % msg_err)

    print("--- BUILD RESULT START ---")
    print("Messages Read: %s" % messages_read)
    if messages_read:
        print("Errors: %d" % errors)
        print("Warnings: %d" % warnings)
        for line in detail_lines:
            print(line)
    else:
        print("Note: build messages could not be read from the store; see raw output / CODESYS messages.")
    print("--- BUILD RESULT END ---")

    print("Compiled Application: %s" % app_name); print("In Project: %s" % project_name)
    if messages_read and errors > 0:
        print("SCRIPT_ERROR: Build failed with %d error(s) and %d warning(s)." % (errors, warnings)); sys.exit(1)
    if messages_read:
        print("SCRIPT_SUCCESS: Build completed with %d error(s), %d warning(s)." % (errors, warnings)); sys.exit(0)
    print("SCRIPT_SUCCESS: Build command executed (results unavailable)."); sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error initiating compilation for project %s: %s\\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

    const GET_PROJECT_STRUCTURE_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
# FIND_OBJECT_BY_PATH_PYTHON_SNIPPET is NOT needed here, we start from project root.

def get_object_structure(obj, indent=0, max_depth=10): # Add max_depth
    lines = []; indent_str = "  " * indent
    if indent > max_depth:
        lines.append("%s- Max recursion depth reached." % indent_str)
        return lines
    try:
        name = "Unnamed"; obj_type = type(obj).__name__
        guid_str = ""
        folder_str = ""
        try:
            name = getattr(obj, 'get_name', lambda: "Unnamed")() or "Unnamed" # Safer get_name
            if hasattr(obj, 'guid'): guid_str = " {%s}" % obj.guid
            if hasattr(obj, 'is_folder') and obj.is_folder: folder_str = " [Folder]"
        except Exception as name_err:
             print("WARN: Error getting name/guid/folder status for an object: %s" % name_err)
             name = "!!! Error Getting Name !!!"

        lines.append("%s- %s (%s)%s%s" % (indent_str, name, obj_type, folder_str, guid_str))

        # Get children only if the object potentially has them
        children = []
        can_have_children = hasattr(obj, 'get_children') and (
            not hasattr(obj, 'is_folder') or # If it's not clear if it's a folder (e.g., project root)
            (hasattr(obj, 'is_folder') and obj.is_folder) or # If it is a folder
             # Add known container types explicitly, check marker interfaces too
             hasattr(obj, 'is_project') or hasattr(obj, 'is_application') or hasattr(obj, 'is_device') or hasattr(obj,'is_pou')
        )

        if can_have_children:
            try:
                children = obj.get_children(False)
                # print("DEBUG: %s has %d children" % (name, len(children))) # Verbose
            except Exception as get_child_err:
                lines.append("%s  ERROR getting children: %s" % (indent_str, get_child_err))
                # traceback.print_exc() # Optional

        for child in children:
            lines.extend(get_object_structure(child, indent + 1, max_depth)) # Recurse

    except Exception as e:
        lines.append("%s- Error processing node: %s" % (indent_str, e))
        traceback.print_exc() # Print detailed error for this node
    return lines
try:
    print("DEBUG: Getting structure for: %s" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_name = os.path.basename(PROJECT_FILE_PATH)
    print("DEBUG: Getting structure for project: %s" % project_name)
    # Use the project object obtained from ensure_project_open
    structure_list = get_object_structure(primary_project, max_depth=15) # Set a reasonable depth
    structure_output = "\\n".join(structure_list)
    # Ensure markers are printed distinctly
    print("\\n--- PROJECT STRUCTURE START ---")
    print(structure_output)
    print("--- PROJECT STRUCTURE END ---\\n")
    print("SCRIPT_SUCCESS: Project structure retrieved."); sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error getting structure for %s: %s\\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

    const GET_POU_CODE_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
${FIND_OBJECT_BY_PATH_PYTHON_SNIPPET}
POU_FULL_PATH = "{POU_FULL_PATH}"; CODE_START_MARKER = "### POU CODE START ###"; CODE_END_MARKER = "### POU CODE END ###"
DECL_START_MARKER = "### POU DECLARATION START ###"; DECL_END_MARKER = "### POU DECLARATION END ###"
IMPL_START_MARKER = "### POU IMPLEMENTATION START ###"; IMPL_END_MARKER = "### POU IMPLEMENTATION END ###"

try:
    print("DEBUG: Getting code: POU_FULL_PATH='%s', Project='%s'" % (POU_FULL_PATH, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not POU_FULL_PATH: raise ValueError("POU full path empty.")

    # Find the target POU/Method/Property object
    target_object = find_object_by_path_robust(primary_project, POU_FULL_PATH, "target object")
    if not target_object: raise ValueError("Target object not found using path: %s" % POU_FULL_PATH)

    target_name = getattr(target_object, 'get_name', lambda: POU_FULL_PATH)()
    print("DEBUG: Found target object: %s" % target_name)

    declaration_code = ""; implementation_code = ""

    # --- Get Declaration Part ---
    if hasattr(target_object, 'textual_declaration'):
        decl_obj = target_object.textual_declaration
        if decl_obj and hasattr(decl_obj, 'text'):
            try:
                declaration_code = decl_obj.text
                print("DEBUG: Got declaration text.")
            except Exception as decl_read_err:
                print("ERROR: Failed to read declaration text: %s" % decl_read_err)
                declaration_code = "/* ERROR reading declaration: %s */" % decl_read_err
        else:
            print("WARN: textual_declaration exists but is None or has no 'text' attribute.")
    else:
        print("WARN: No textual_declaration attribute.")

    # --- Get Implementation Part ---
    if hasattr(target_object, 'textual_implementation'):
        impl_obj = target_object.textual_implementation
        if impl_obj and hasattr(impl_obj, 'text'):
            try:
                implementation_code = impl_obj.text
                print("DEBUG: Got implementation text.")
            except Exception as impl_read_err:
                print("ERROR: Failed to read implementation text: %s" % impl_read_err)
                implementation_code = "/* ERROR reading implementation: %s */" % impl_read_err
        else:
            print("WARN: textual_implementation exists but is None or has no 'text' attribute.")
    else:
        print("WARN: No textual_implementation attribute.")


    print("Code retrieved for: %s" % target_name)
    # Print declaration between markers, ensuring markers are on separate lines
    print("\\n" + DECL_START_MARKER)
    print(declaration_code)
    print(DECL_END_MARKER + "\\n")
    # Print implementation between markers
    print(IMPL_START_MARKER)
    print(implementation_code)
    print(IMPL_END_MARKER + "\\n")

    # --- LEGACY MARKERS for backward compatibility if needed ---
    # Combine both for old marker format, adding a separator line
    # legacy_combined_code = declaration_code + "\\n\\n// Implementation\\n" + implementation_code
    # print(CODE_START_MARKER); print(legacy_combined_code); print(CODE_END_MARKER)
    # --- END LEGACY ---

    print("SCRIPT_SUCCESS: Code retrieved."); sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error getting code for object '%s' in project '%s': %s\\n%s" % (POU_FULL_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

    const IMPORT_XML_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
${FIND_OBJECT_BY_PATH_PYTHON_SNIPPET}
XML_FILE_PATH = r"{XML_FILE_PATH}"
TARGET_PATH = "{TARGET_PATH}"
IMPORT_FOLDER_STRUCTURE = {IMPORT_FOLDER_STRUCTURE}
CONFLICT_RESOLVE_NAME = "{CONFLICT_RESOLVE}"

# Resolve the requested conflict strategy (Replace / Copy / Skip), defaulting to Replace.
_conflict = script_engine.ConflictResolve.Replace
try:
    _conflict = getattr(script_engine.ConflictResolve, CONFLICT_RESOLVE_NAME, script_engine.ConflictResolve.Replace)
except Exception as _ce:
    print("WARN: Could not resolve ConflictResolve.%s: %s" % (CONFLICT_RESOLVE_NAME, _ce))

# Reporter implementing IImportReporter to collect errors/warnings and drive conflict resolution.
class _ImportReporter(script_engine.ImportReporter):
    def __init__(self, conflict):
        self.errors = []
        self.warnings = []
        self.added_count = 0
        self._conflict = conflict
    def error(self, message):
        self.errors.append(str(message))
    def warning(self, message):
        self.warnings.append(str(message))
    def resolve_conflict(self, obj):
        return self._conflict
    def added(self, obj):
        self.added_count += 1

try:
    print("DEBUG: import_xml script: XML='%s', Target='%s', FolderStruct=%s, Conflict=%s, Project='%s'" % (XML_FILE_PATH, TARGET_PATH, IMPORT_FOLDER_STRUCTURE, CONFLICT_RESOLVE_NAME, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not XML_FILE_PATH: raise ValueError("PLCopenXML file path empty.")
    XML_FILE_PATH = os.path.normpath(XML_FILE_PATH)
    if not os.path.exists(XML_FILE_PATH): raise IOError("PLCopenXML file not found: %s" % XML_FILE_PATH)

    reporter = _ImportReporter(_conflict)

    def _import_into(obj, label):
        # import_xml signatures differ across object/project types (reporter is the
        # 2nd positional argument in practice). Try positional forms, degrade gracefully.
        attempts = [
            lambda: obj.import_xml(XML_FILE_PATH, reporter, IMPORT_FOLDER_STRUCTURE),
            lambda: obj.import_xml(XML_FILE_PATH, reporter),
            lambda: obj.import_xml(XML_FILE_PATH),
        ]
        last_err = None
        for attempt in attempts:
            try:
                attempt()
                return
            except TypeError as te:
                last_err = te
                print("DEBUG: import_xml call form failed for %s: %s" % (label, te))
        raise last_err

    def _child_names(obj):
        try:
            return set(getattr(c, 'get_name', lambda: str(c))() for c in obj.get_children(False))
        except Exception as che:
            print("DEBUG: Could not list children: %s" % che)
            return set()

    # Resolve the container and snapshot its children so we can report an accurate
    # added count (the reporter.added() callback does not fire reliably).
    if TARGET_PATH:
        container = find_object_by_path_robust(primary_project, TARGET_PATH, "import target")
        if not container: raise ValueError("Target object not found for path: %s" % TARGET_PATH)
        if not hasattr(container, 'import_xml'):
            raise TypeError("Target object '%s' (%s) does not support import_xml." % (TARGET_PATH, type(container).__name__))
        container_label = TARGET_PATH
    else:
        container = primary_project
        container_label = "<project>"

    before_names = _child_names(container)
    print("DEBUG: Importing PLCopenXML into '%s' (%d existing children)..." % (container_label, len(before_names)))
    _import_into(container, container_label)
    after_names = _child_names(container)
    added_objects = len(after_names - before_names)
    print("DEBUG: import_xml returned. Net new children: %d (reporter.added=%d)" % (added_objects, reporter.added_count))

    try:
        primary_project.save()
        print("DEBUG: Project saved after import.")
    except Exception as save_err:
        print("WARN: Failed to save project after import: %s" % save_err)

    print("--- IMPORT RESULT START ---")
    print("Added: %d" % added_objects)
    print("Errors: %d" % len(reporter.errors))
    print("Warnings: %d" % len(reporter.warnings))
    for e in reporter.errors: print("ERROR: %s" % e)
    for w in reporter.warnings: print("WARNING: %s" % w)
    print("--- IMPORT RESULT END ---")

    if reporter.errors:
        print("SCRIPT_ERROR: PLCopenXML import completed with %d error(s)." % len(reporter.errors)); sys.exit(1)
    print("Imported PLCopenXML: %s" % XML_FILE_PATH)
    print("SCRIPT_SUCCESS: PLCopenXML import successful (%d added, %d warning(s))." % (added_objects, len(reporter.warnings))); sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error importing PLCopenXML '%s' into project '%s': %s\\n%s" % (XML_FILE_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
`;

    const CFC_ADD_DEVICE_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, re, uuid, tempfile, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
TEMPLATE_PATH = r"{TEMPLATE_PATH}"
NEW_NAME = "{NEW_NAME}"
NEW_INSTANCE = "{NEW_INSTANCE}"
INSTANCE_TYPE = "{INSTANCE_TYPE}"
TARGET_FOLDER = "{TARGET_FOLDER}"
GVL_NAME = "{GVL_NAME}"
INTERLOCK = "{INTERLOCK}"
REBIND = {REBIND}
DO_BUILD = {DO_BUILD}

def _find_value(text, pat):
    m = re.search(pat, text)
    return m.group(1) if m else None

try:
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    TEMPLATE_PATH = os.path.normpath(TEMPLATE_PATH)
    if not os.path.exists(TEMPLATE_PATH):
        raise IOError("Template export not found: %s" % TEMPLATE_PATH)
    f = open(TEMPLATE_PATH, "r"); xml = f.read(); f.close()

    # --- auto-detect template name / bound instance / FB type ---
    old_name = _find_value(xml, '<Single Name="Name" Type="string">([^<]+)</Single>')
    box_type = _find_value(xml, '<Single Name="BoxType" Type="string">([^<]+)</Single>')
    old_inst = None
    ipos = xml.find('<Single Name="Instance"')
    if ipos != -1:
        old_inst = _find_value(xml[ipos:], '<Single Name="Operand" Type="string">([^<]+)</Single>')
    if not old_name or not old_inst:
        raise RuntimeError("Could not detect template name/instance (name=%s inst=%s)." % (old_name, old_inst))
    inst_type = INSTANCE_TYPE if INSTANCE_TYPE else (box_type if box_type else "")
    if not inst_type:
        raise RuntimeError("No instanceType given and BoxType not found in template.")
    print("DEBUG: cfc_add_device: template name=%s inst=%s box=%s -> new name=%s inst=%s type=%s" % (old_name, old_inst, box_type, NEW_NAME, NEW_INSTANCE, inst_type))

    # --- rebind (pure text) ---
    xml = xml.replace(">" + old_name + "<", ">" + NEW_NAME + "<")
    xml = xml.replace("PROGRAM " + old_name, "PROGRAM " + NEW_NAME)
    xml = xml.replace('<Single Name="Operand" Type="string">' + old_inst + '</Single>', '<Single Name="Operand" Type="string">' + NEW_INSTANCE + '</Single>')
    # extra operand rebinds (e.g. a controller's driven actuator Y103=Y5)
    for rb in REBIND:
        if "=" in rb:
            a, b = rb.split("=", 1)
            xml = xml.replace('<Single Name="Operand" Type="string">' + a.strip() + '</Single>', '<Single Name="Operand" Type="string">' + b.strip() + '</Single>')
    if INTERLOCK:
        xml = xml.replace('<Single Name="Operand" Type="string">FALSE</Single>', '<Single Name="Operand" Type="string">' + INTERLOCK + '</Single>', 1)
    gm = re.search('<Single Name="Guid" Type="System.Guid">([^<]+)</Single>', xml)
    if gm:
        xml = xml[:gm.start(1)] + str(uuid.uuid4()) + xml[gm.end(1):]

    gen_path = os.path.join(tempfile.gettempdir(), NEW_NAME + "_gen.export")
    g = open(gen_path, "w"); g.write(xml); g.close()

    app = primary_project.active_application

    # --- ensure the new instance is declared in the GVL ---
    gvl = None
    for c in primary_project.get_children(True):
        try:
            if c.get_name() == GVL_NAME and getattr(c, "has_textual_declaration", False):
                gvl = c; break
        except Exception:
            pass
    gvl_changed = False
    if gvl is not None:
        decl = gvl.textual_declaration.text
        compact = decl.replace(" ", "").replace(chr(9), "")
        if (NEW_INSTANCE + ":") not in compact:
            idx = decl.rfind("END_VAR")
            if idx == -1:
                raise RuntimeError("GVL '%s' has no END_VAR." % GVL_NAME)
            ins = chr(9) + NEW_INSTANCE + " : " + inst_type + ";" + chr(10)
            gvl.textual_declaration.replace(decl[:idx] + ins + decl[idx:])
            gvl_changed = True
    else:
        print("WARN: GVL '%s' not found; instance not declared." % GVL_NAME)

    # --- remove any existing same-name program (idempotent), then import ---
    for o in list(primary_project.find(NEW_NAME, True)):
        try: o.remove()
        except Exception: pass
    folder = None
    for c in primary_project.get_children(True):
        try:
            if c.get_name() == TARGET_FOLDER and getattr(c, "is_folder", False):
                folder = c; break
        except Exception:
            pass
    if folder is None:
        folder = app
    folder.import_native([gen_path])
    objs = list(primary_project.find(NEW_NAME, True))
    added = len(objs)

    # --- round-trip verification ---
    has_box = False; has_inst = False
    if objs:
        reexp = os.path.join(tempfile.gettempdir(), NEW_NAME + "_reexport.export")
        primary_project.export_native([objs[0]], reexp, recursive=True)
        rf = open(reexp, "r"); rx = rf.read(); rf.close()
        has_box = (box_type in rx) if box_type else False
        has_inst = ('<Single Name="Operand" Type="string">' + NEW_INSTANCE + '</Single>') in rx

    primary_project.save()

    # --- optional build + message-store evaluation ---
    errors = 0; warnings = 0; messages_read = False; detail_lines = []
    if DO_BUILD and app is not None and hasattr(app, "build"):
        app.build()
        try:
            _sys = None
            try: _sys = system
            except NameError: _sys = getattr(script_engine, "system", None)
            sev_enum = getattr(script_engine, "Severity", None)
            if _sys is not None and sev_enum is not None:
                for cat in _sys.get_message_categories(True):
                    cid = str(cat)
                    for sev in [sev_enum.FatalError, sev_enum.Error]:
                        for m in _sys.get_message_objects(category=cid, severities=sev):
                            errors += 1; detail_lines.append("ERROR: %s" % (getattr(m, "text", None) or str(m)))
                    for m in _sys.get_message_objects(category=cid, severities=sev_enum.Warning):
                        warnings += 1; detail_lines.append("WARNING: %s" % (getattr(m, "text", None) or str(m)))
                messages_read = True
        except Exception as msg_err:
            print("WARN: build message read failed: %s" % msg_err)

    print("--- CFC RESULT START ---")
    print("Added: %d" % added)
    print("Errors: %d" % errors)
    print("Warnings: %d" % warnings)
    print("Verify: box=%s instance=%s" % (has_box, has_inst))
    print("GvlChanged: %s" % gvl_changed)
    for line in detail_lines: print(line)
    print("--- CFC RESULT END ---")

    if added < 1:
        print("SCRIPT_ERROR: device program '%s' was not created." % NEW_NAME); sys.exit(1)
    if DO_BUILD and messages_read and errors > 0:
        print("SCRIPT_ERROR: build failed with %d error(s)." % errors); sys.exit(1)
    print("SCRIPT_SUCCESS: device '%s' (instance %s) added as CFC." % (NEW_NAME, NEW_INSTANCE)); sys.exit(0)
except Exception as e:
    print("SCRIPT_ERROR: %s\\n%s" % (e, traceback.format_exc())); sys.exit(1)
`;

    const CATALOG_LIST_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
INCLUDE_MEMBERS = {INCLUDE_MEMBERS}

def _decl(o):
    try:
        if getattr(o, "has_textual_declaration", False):
            t = o.textual_declaration.text or ""
            for ln in t.split(chr(10)):
                s = ln.strip()
                if s and not s.startswith("//") and not s.startswith("(*"):
                    return s
    except Exception:
        pass
    return ""

_count = [0]
def _walk(o, depth):
    try:
        children = o.get_children(False)
    except Exception:
        return
    for c in children:
        try: name = c.get_name()
        except Exception: name = "<?>"
        is_folder = bool(getattr(c, "is_folder", False))
        decl = _decl(c)
        kind = "FOLDER" if is_folder else (decl.split(" ")[0] if decl else "")
        is_member = decl.startswith("METHOD") or decl.startswith("PROPERTY") or decl.startswith("{attribute") or name in ("Get", "Set")
        show = INCLUDE_MEMBERS or (not is_member)
        if show:
            _count[0] += 1
            print("ITEM: %s%s | %s | %s" % ("  " * depth, name, kind, decl[:90]))
            _walk(c, depth + 1)

try:
    proj = ensure_project_open(PROJECT_FILE_PATH)
    print("--- CATALOG START ---")
    _walk(proj, 0)
    print("--- CATALOG END ---")
    print("Count: %d" % _count[0])
    print("SCRIPT_SUCCESS: catalog listed (%d items)." % _count[0]); sys.exit(0)
except Exception as e:
    print("SCRIPT_ERROR: %s" % e); traceback.print_exc(); sys.exit(1)
`;

    const SIM_RUN_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, time, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
READ_VARS = {READ_VARS}
FORCE_VARS = {FORCE_VARS}
RUN_SECONDS = {RUN_SECONDS}
DO_BUILD = {DO_BUILD}

oa = None; dev = None
try:
    p = ensure_project_open(PROJECT_FILE_PATH)
    app = p.active_application or (p.find("Application", True) or [None])[0]
    if app is None:
        raise RuntimeError("No application found.")
    if DO_BUILD and hasattr(app, "build"):
        app.build()
    for c in p.get_children(False):
        if getattr(c, "is_device", False):
            dev = c; break
    if dev is None:
        raise RuntimeError("No device found in project.")
    dev.set_simulation_mode(True)
    _online = None
    try: _online = online
    except NameError: _online = getattr(script_engine, "online", None)
    if _online is None:
        raise RuntimeError("Scripting 'online' object not available.")
    oa = _online.create_online_application(app)
    oa.login(script_engine.OnlineChangeOption.Never, True)
    try: oa.start()
    except Exception as start_err:
        print("DEBUG: start raised: %s" % type(start_err).__name__)
    state = None
    for k in range(8):
        try: state = str(oa.application_state)
        except Exception: state = None
        if state == "run": break
        time.sleep(1.0)
    forced = []
    for fv in FORCE_VARS:
        if "=" in fv:
            expr, val = fv.split("=", 1)
            try:
                oa.set_prepared_value(expr.strip(), val.strip()); forced.append(expr.strip())
            except Exception as fe:
                print("WARN: force %s failed: %s" % (fv, fe))
    if forced:
        try: oa.force_prepared_values()
        except Exception as fpe: print("WARN: force_prepared_values: %s" % fpe)
    if RUN_SECONDS > 0:
        time.sleep(RUN_SECONDS)
    print("--- SIM RESULT START ---")
    print("State: %s" % state)
    print("Forced: %d" % len(forced))
    for v in READ_VARS:
        try: print("VALUE: %s = %s" % (v, oa.read_value(v)))
        except Exception as rd_err: print("VALUE: %s = <error: %s>" % (v, rd_err))
    print("--- SIM RESULT END ---")
    if state == "run":
        print("SCRIPT_SUCCESS: simulation ran (state=%s)." % state); sys.exit(0)
    print("SCRIPT_ERROR: simulation did not reach run (state=%s)." % state); sys.exit(1)
except Exception as e:
    print("SCRIPT_ERROR: %s" % e); traceback.print_exc(); sys.exit(1)
finally:
    try:
        if oa is not None:
            try: oa.unforce_all_values()
            except Exception: pass
            try: oa.stop()
            except Exception: pass
            try: oa.logout()
            except Exception: pass
        if dev is not None:
            try: dev.set_simulation_mode(False)
            except Exception: pass
    except Exception: pass
`;

    const SCAFFOLD_PLANT_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, shutil, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
SKELETON_PATH = r"{SKELETON_PATH}"
OVERWRITE = {OVERWRITE}
DO_BUILD = {DO_BUILD}

try:
    SKELETON_PATH = os.path.normpath(SKELETON_PATH)
    if not os.path.exists(SKELETON_PATH):
        raise IOError("Skeleton project not found: %s" % SKELETON_PATH)
    target = os.path.normpath(PROJECT_FILE_PATH)
    if os.path.normcase(os.path.abspath(target)) == os.path.normcase(os.path.abspath(SKELETON_PATH)):
        raise ValueError("Target path equals skeleton path.")
    if os.path.exists(target) and not OVERWRITE:
        raise IOError("Target already exists (set overwrite=true to replace): %s" % target)
    tdir = os.path.dirname(target)
    if tdir and not os.path.exists(tdir):
        os.makedirs(tdir)
    shutil.copy(SKELETON_PATH, target)
    print("DEBUG: scaffold: copied skeleton -> %s" % target)

    primary_project = ensure_project_open(target)
    app = primary_project.active_application or (primary_project.find("Application", True) or [None])[0]

    errors = 0; warnings = 0; messages_read = False
    if DO_BUILD and app is not None and hasattr(app, "build"):
        app.build()
        try:
            _sys = None
            try: _sys = system
            except NameError: _sys = getattr(script_engine, "system", None)
            sev_enum = getattr(script_engine, "Severity", None)
            if _sys is not None and sev_enum is not None:
                for cat in _sys.get_message_categories(True):
                    cid = str(cat)
                    for sev in [sev_enum.FatalError, sev_enum.Error]:
                        for m in _sys.get_message_objects(category=cid, severities=sev): errors += 1
                    for m in _sys.get_message_objects(category=cid, severities=sev_enum.Warning): warnings += 1
                messages_read = True
        except Exception as msg_err:
            print("WARN: build message read failed: %s" % msg_err)

    have = []
    for nm in ["GVL", "CFCs", "SFCs", "PLC_PRG"]:
        have.append("%s=%s" % (nm, len(list(primary_project.find(nm, True))) > 0))
    primary_project.save()

    print("--- SCAFFOLD RESULT START ---")
    print("Errors: %d" % errors)
    print("Warnings: %d" % warnings)
    print("Structure: %s" % ", ".join(have))
    print("--- SCAFFOLD RESULT END ---")

    if DO_BUILD and messages_read and errors > 0:
        print("SCRIPT_ERROR: scaffold build failed with %d error(s)." % errors); sys.exit(1)
    print("SCRIPT_SUCCESS: plant scaffolded at %s." % target); sys.exit(0)
except Exception as e:
    print("SCRIPT_ERROR: %s\\n%s" % (e, traceback.format_exc())); sys.exit(1)
`;

    const SET_ORCHESTRATOR_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
POU_NAME = "{POU_NAME}"
CALLS = {CALLS}
DO_BUILD = {DO_BUILD}

try:
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    target = None
    for o in primary_project.find(POU_NAME, True):
        if not getattr(o, "is_device", False) and getattr(o, "has_textual_implementation", False):
            target = o; break
    if target is None:
        raise RuntimeError("Orchestrator POU '%s' not found." % POU_NAME)
    # set ONLY the implementation (never the declaration) -> task binding stays intact
    body = (chr(10)).join([str(c).strip() + "();" for c in CALLS if str(c).strip()])
    target.textual_implementation.replace(body)
    primary_project.save()

    app = primary_project.active_application or (primary_project.find("Application", True) or [None])[0]
    errors = 0; warnings = 0; messages_read = False
    if DO_BUILD and app is not None and hasattr(app, "build"):
        app.build()
        try:
            _sys = None
            try: _sys = system
            except NameError: _sys = getattr(script_engine, "system", None)
            sev_enum = getattr(script_engine, "Severity", None)
            if _sys is not None and sev_enum is not None:
                for cat in _sys.get_message_categories(True):
                    cid = str(cat)
                    for sev in [sev_enum.FatalError, sev_enum.Error]:
                        for m in _sys.get_message_objects(category=cid, severities=sev): errors += 1
                    for m in _sys.get_message_objects(category=cid, severities=sev_enum.Warning): warnings += 1
                messages_read = True
        except Exception as msg_err:
            print("WARN: build message read failed: %s" % msg_err)

    ncalls = len([c for c in CALLS if str(c).strip()])
    print("--- ORCH RESULT START ---")
    print("POU: %s" % POU_NAME)
    print("Calls: %d" % ncalls)
    print("Errors: %d" % errors)
    print("Warnings: %d" % warnings)
    print("--- ORCH RESULT END ---")
    if DO_BUILD and messages_read and errors > 0:
        print("SCRIPT_ERROR: orchestrator build failed with %d error(s)." % errors); sys.exit(1)
    print("SCRIPT_SUCCESS: orchestrator %s set with %d call(s)." % (POU_NAME, ncalls)); sys.exit(0)
except Exception as e:
    print("SCRIPT_ERROR: %s\\n%s" % (e, traceback.format_exc())); sys.exit(1)
`;

    const CFC_BUILD_DEVICE_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, os, uuid, tempfile, json, traceback
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
NAME = "{NAME}"
BOX_TYPE = "{BOX_TYPE}"
INSTANCE = "{INSTANCE}"
INSTANCE_TYPE = "{INSTANCE_TYPE}"
INPUTS = json.loads('''{INPUTS_JSON}''')
OUTPUTS = json.loads('''{OUTPUTS_JSON}''')
TARGET_FOLDER = "{TARGET_FOLDER}"
GVL_NAME = "{GVL_NAME}"
DECLARE_GVL = {DECLARE_GVL}
DO_BUILD = {DO_BUILD}

FLAGS = ('<Single Name="Flags" Type="{668066f2-6069-46b3-8962-8db8d13d7db2}" Method="IArchivable">'
         '<Single Name="Flags" Type="int">0</Single>'
         '<Single Name="Fixed" Type="bool">%s</Single>'
         '<Single Name="Extensible" Type="bool">False</Single></Single>')

def operand_block(operand, typ, oid, is_instance):
    return ('<Single Name="Operand" Type="{c9b2f165-48a2-4a45-8326-3952d8a3d708}" Method="IArchivable">'
            '<Single Name="Operand" Type="string">%s</Single>'
            '<Single Name="Type" Type="string">%s</Single>'
            '<Single Name="Comment" Type="string" /><Single Name="SymbolComment" Type="string" />'
            '<Single Name="Address" Type="string" />' + FLAGS % 'True' +
            '<Single Name="LValue" Type="bool">False</Single>'
            '<Single Name="Boolean" Type="bool">False</Single>'
            '<Single Name="IsInstance" Type="bool">%s</Single>'
            '<Single Name="Id" Type="long">%d</Single></Single>') % (operand, typ, str(is_instance), oid)

def build_device_cfc(name, box_type, instance, inputs, outputs):
    meta_guid = str(uuid.uuid4()); sv_guid = str(uuid.uuid4())
    next_id = 5
    in_items = []
    for (pn, pt, op) in inputs:
        item_id = next_id; opnd_id = next_id + 1; next_id += 2
        in_items.append('<Single Type="{9de7f100-1b87-424c-a62e-45b0cfc85ed2}" Method="IArchivable">'
                        + operand_block(op, pt, opnd_id, False) +
                        '<Single Name="Id" Type="long">%d</Single></Single>' % item_id)
    uid = next_id
    in_names = ''.join('<Single Type="string">%s</Single>' % p[0] for p in inputs)
    in_types = ''.join('<Single Type="string">%s</Single>' % p[1] for p in inputs)
    out_names = ''.join('<Single Type="string">%s</Single>' % p[0] for p in outputs)
    out_types = ''.join('<Single Type="string">%s</Single>' % p[1] for p in outputs)
    box = ('<Single Type="{acfc6f68-8e3a-4af5-bf81-3dd512095a46}" Method="IArchivable">'
           '<Single Name="BoxType" Type="string">%s</Single>' % box_type +
           '<Single Name="Instance" Type="{c9b2f165-48a2-4a45-8326-3952d8a3d708}" Method="IArchivable">'
           '<Single Name="Operand" Type="string">%s</Single>'
           '<Single Name="Type" Type="string">%s</Single>'
           '<Single Name="Comment" Type="string" /><Single Name="SymbolComment" Type="string" />'
           '<Single Name="Address" Type="string" />' % (instance, box_type) + FLAGS % 'False' +
           '<Single Name="LValue" Type="bool">False</Single><Single Name="Boolean" Type="bool">False</Single>'
           '<Single Name="IsInstance" Type="bool">True</Single><Single Name="Id" Type="long">3</Single></Single>'
           '<Single Name="OutputItems" Type="{f40d3e09-c02c-4522-a88c-dac23558cfc4}" Method="IArchivable">'
           '<List2 Name="OutputItems"><Null /></List2></Single>' + FLAGS % 'True' +
           '<Null Name="InputFlags" /><List2 Name="InputItems">' + ''.join(in_items) + '</List2>'
           '<Single Name="InputParam" Type="{71496971-9e0c-4677-a832-b9583b571130}" Method="IArchivable">'
           '<List2 Name="Names">' + in_names + '</List2><List2 Name="Types">' + in_types + '</List2></Single>'
           '<Single Name="OutputParam" Type="{71496971-9e0c-4677-a832-b9583b571130}" Method="IArchivable">'
           '<List2 Name="Names">' + out_names + '</List2><List2 Name="Types">' + out_types + '</List2></Single>'
           '<Single Name="CallType" Type="{bffb3c53-f105-4e85-aba2-e30df579d75f}">FunctionBlock</Single>'
           '<Null Name="EN" /><Null Name="ENO" /><Null Name="STSnippet" />'
           '<Single Name="ContainsExtensibleInputs" Type="bool">False</Single>'
           '<Single Name="ProvidesSTSnippet" Type="bool">False</Single>'
           '<Single Name="Id" Type="long">4</Single></Single>')
    network = ('<Single Type="{d9a99d73-b633-47db-b876-a752acb25871}" Method="IArchivable">'
               '<Single Name="ILActive" Type="bool">False</Single><Single Name="FBDValid" Type="bool">False</Single>'
               '<Single Name="ILValid" Type="bool">False</Single><List2 Name="ILLines" />'
               '<Single Name="Comment" Type="string" /><Single Name="Title" Type="string" />'
               '<Single Name="Label" Type="string" /><Single Name="OutCommented" Type="bool">False</Single>'
               '<List2 Name="NetworkItems">' + box + '</List2><List2 Name="Connectors" />'
               '<Single Name="Id" Type="long">2</Single></Single>')
    return ('<ExportFile><StructuredView Guid="{%s}">' % sv_guid +
        '<Single xml:space="preserve" Type="{3daac5e4-660e-42e4-9cea-3711b98bfb63}" Method="IArchivable">'
        '<Null Name="Profile" /><List2 Name="EntryList">'
        '<Single Type="{6198ad31-4b98-445c-927f-3258a0e82fe3}" Method="IArchivable">'
        '<Single Name="IsRoot" Type="bool">True</Single>'
        '<Single Name="MetaObject" Type="{81297157-7ec9-45ce-845e-84cab2b88ade}" Method="IArchivable">'
        '<Single Name="Guid" Type="System.Guid">%s</Single>' % meta_guid +
        '<Single Name="ParentGuid" Type="System.Guid">5821422e-b860-4b0b-bfa1-90c759caf2ea</Single>'
        '<Single Name="Name" Type="string">%s</Single>' % name +
        '<Dictionary Type="{2c41fa04-1834-41c1-816e-303c7aa2c05b}" Name="Properties">'
        '<Entry><Key><Single Type="System.Guid">24568a24-c491-472c-a21f-ee5d33859fab</Single></Key>'
        '<Value><Single Type="{24568a24-c491-472c-a21f-ee5d33859fab}" Method="IArchivable">'
        '<Single Name="MemoryReserveForOnlineChange" Type="int">0</Single>'
        '<Single Name="ExcludeFromBuild" Type="bool">False</Single>'
        '<Single Name="External" Type="bool">False</Single>'
        '<Single Name="EnableSystemCall" Type="bool">False</Single>'
        '<Single Name="CompilerDefines" Type="string" /><Single Name="LinkAlways" Type="bool">False</Single>'
        '<Array Name="Undefines" Type="string" /></Single></Value></Entry></Dictionary>'
        '<Single Name="TypeGuid" Type="System.Guid">6f9dac99-8de1-4efc-8465-68ac443b7d08</Single>'
        '<Array Name="EmbeddedTypeGuids" Type="System.Guid">'
        '<Single Type="System.Guid">a9ed5b7e-75c5-4651-af16-d2c27e98cb94</Single>'
        '<Single Type="System.Guid">25e509de-33d4-4447-93f8-c9e4ea381c8b</Single></Array>'
        '<Single Name="Timestamp" Type="long">637870852889073338</Single></Single>'
        '<Single Name="Object" Type="{6f9dac99-8de1-4efc-8465-68ac443b7d08}" Method="IArchivable">'
        '<Single Name="SpecialFunc" Type="{0db3d7bb-cde0-4416-9a7b-ce49a0124323}">None</Single>'
        '<Single Name="Implementation" Type="{25e509de-33d4-4447-93f8-c9e4ea381c8b}" Method="IArchivable">'
        '<Single Name="NetworkListComment" Type="string" /><Single Name="DefaultViewMode" Type="string">Fbd</Single>'
        '<List2 Name="NetworkList">' + network + '</List2>'
        '<Single Name="BranchCounter" Type="int">1</Single><Single Name="ValidIds" Type="bool">True</Single></Single>'
        '<Single Name="Interface" Type="{a9ed5b7e-75c5-4651-af16-d2c27e98cb94}" Method="IArchivable">'
        '<Single Name="TextDocument" Type="{f3878285-8e4f-490b-bb1b-9acbb7eb04db}" Method="IArchivable">'
        '<Single Name="TextBlobForSerialisation" Type="string">PROGRAM %s%s</Single>' % (name, chr(10)) +
        '<Single Name="LineInfoPersistence" Type="string">85f4ce70-1cb5-40e6-b789-431475238748_Decl_LineIds</Single>'
        '</Single></Single><Single Name="UniqueIdGenerator" Type="string">%d</Single>' % uid +
        '<Single Name="POULevel" Type="{8e575c5b-1d37-49c6-941b-5c0ec7874787}">Standard</Single>'
        '<List Name="ChildObjectGuids" Type="System.Collections.ArrayList" />'
        '<Single Name="AddAttributeSubsequent" Type="bool">False</Single></Single>'
        '<Single Name="ParentSVNodeGuid" Type="System.Guid">65906c51-42fe-4a26-a9f5-71a08369fa00</Single>'
        '<Array Name="Path" Type="string"><Single Type="string">CODESYS_Control_Win_V3</Single>'
        '<Single Type="string">SPS-Logik</Single><Single Type="string">Application</Single>'
        '<Single Type="string">CFCs</Single></Array><Single Name="Index" Type="int">-1</Single></Single>'
        '</List2><Null Name="ProfileName" /></Single></StructuredView></ExportFile>')

try:
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    itype = INSTANCE_TYPE if INSTANCE_TYPE else BOX_TYPE
    ins = [(i["pin"], i["type"], i.get("operand", "")) for i in INPUTS]
    outs = [(o["pin"], o["type"]) for o in OUTPUTS]
    xml = build_device_cfc(NAME, BOX_TYPE, INSTANCE, ins, outs)
    gen_path = os.path.join(tempfile.gettempdir(), NAME + "_build.export")
    g = open(gen_path, "w"); g.write(xml); g.close()

    app = primary_project.active_application or (primary_project.find("Application", True) or [None])[0]
    gvl_changed = False
    if DECLARE_GVL and INSTANCE:
        gvl = None
        for c in primary_project.get_children(True):
            try:
                if c.get_name() == GVL_NAME and getattr(c, "has_textual_declaration", False):
                    gvl = c; break
            except Exception: pass
        if gvl is not None:
            decl = gvl.textual_declaration.text
            if (INSTANCE + ":") not in decl.replace(" ", "").replace(chr(9), ""):
                idx = decl.rfind("END_VAR")
                if idx != -1:
                    gvl.textual_declaration.replace(decl[:idx] + chr(9) + INSTANCE + " : " + itype + ";" + chr(10) + decl[idx:])
                    gvl_changed = True

    for o in list(primary_project.find(NAME, True)):
        try: o.remove()
        except Exception: pass
    folder = None
    for c in primary_project.get_children(True):
        try:
            if c.get_name() == TARGET_FOLDER and getattr(c, "is_folder", False):
                folder = c; break
        except Exception: pass
    if folder is None: folder = app
    folder.import_native([gen_path])
    objs = list(primary_project.find(NAME, True))
    added = len(objs)

    has_box = False; has_inst = False
    if objs:
        reexp = os.path.join(tempfile.gettempdir(), NAME + "_build_re.export")
        primary_project.export_native([objs[0]], reexp, recursive=True)
        rf = open(reexp, "r"); rx = rf.read(); rf.close()
        has_box = BOX_TYPE in rx
        has_inst = ('<Single Name="Operand" Type="string">' + INSTANCE + '</Single>') in rx if INSTANCE else True
    primary_project.save()

    errors = 0; warnings = 0; messages_read = False
    if DO_BUILD and app is not None and hasattr(app, "build"):
        app.build()
        try:
            _sys = None
            try: _sys = system
            except NameError: _sys = getattr(script_engine, "system", None)
            sev_enum = getattr(script_engine, "Severity", None)
            if _sys is not None and sev_enum is not None:
                for cat in _sys.get_message_categories(True):
                    cid = str(cat)
                    for sev in [sev_enum.FatalError, sev_enum.Error]:
                        for m in _sys.get_message_objects(category=cid, severities=sev): errors += 1
                    for m in _sys.get_message_objects(category=cid, severities=sev_enum.Warning): warnings += 1
                messages_read = True
        except Exception as msg_err:
            print("WARN: build message read failed: %s" % msg_err)

    print("--- CFC RESULT START ---")
    print("Added: %d" % added)
    print("Errors: %d" % errors)
    print("Warnings: %d" % warnings)
    print("Verify: box=%s instance=%s" % (has_box, has_inst))
    print("GvlChanged: %s" % gvl_changed)
    print("--- CFC RESULT END ---")
    if added < 1:
        print("SCRIPT_ERROR: device program '%s' was not created." % NAME); sys.exit(1)
    if DO_BUILD and messages_read and errors > 0:
        print("SCRIPT_ERROR: build failed with %d error(s)." % errors); sys.exit(1)
    print("SCRIPT_SUCCESS: device '%s' synthesized." % NAME); sys.exit(0)
except Exception as e:
    print("SCRIPT_ERROR: %s\\n%s" % (e, traceback.format_exc())); sys.exit(1)
`;

    // --- End Python Script Templates ---

    // --- Zod Schemas (moved for clarity before usage) ---
    const PouTypeEnum = z.enum(["Program", "FunctionBlock", "Function"]);
    const ImplementationLanguageEnum = z.enum(["ST", "LD", "FBD", "SFC", "IL", "CFC", "StructuredText", "LadderDiagram", "FunctionBlockDiagram", "SequentialFunctionChart", "InstructionList", "ContinuousFunctionChart"]);
    // --- End Zod Schemas ---


    // --- MCP Resources / Tools Definitions ---
    console.error("SERVER.TS: Defining Resources and Tools...");

    // --- Resources ---
    server.resource("project-status", "codesys://project/status", async (uri) => {
        console.error(`SERVER.TS Resource request: ${uri.href}`);
        try {
            const result = await executeCodesysScript(CHECK_STATUS_SCRIPT, codesysExePath, codesysProfileName);
            const outputLines = result.output.split(/[\r\n]+/).filter(line => line.trim()); const statusData: { [key: string]: string } = {};
            outputLines.forEach(line => { const match = line.match(/^([^:]+):\s*(.*)$/); if (match) { statusData[match[1].trim()] = match[2].trim(); }});
            const statusText = `CODESYS Status:\n - Scripting OK: ${statusData['Scripting OK'] ?? 'Unknown'}\n - Project Open: ${statusData['Project Open'] ?? 'Unknown'}\n - Project Name: ${statusData['Project Name'] ?? 'Unknown'}\n - Project Path: ${statusData['Project Path'] ?? 'N/A'}`;
            const isError = !result.success || statusData['Scripting OK']?.toLowerCase() !== 'true';
            // **** RETURN MCP STRUCTURE ****
            return { contents: [{ uri: uri.href, text: statusText, contentType: "text/plain" }], isError: isError };
        } catch (error: any) {
            console.error(`Error resource ${uri.href}:`, error);
            // **** RETURN MCP STRUCTURE ****
            return { contents: [{ uri: uri.href, text: `Failed status script: ${error.message}`, contentType: "text/plain" }], isError: true };
        }
    });

    // *** DEFINE TEMPLATES ***
    const projectStructureTemplate = new ResourceTemplate("codesys://project/{+project_path}/structure", { list: undefined });
    const pouCodeTemplate = new ResourceTemplate("codesys://project/{+project_path}/pou/{+pou_path}/code", { list: undefined });
    // *** END DEFINE TEMPLATES ***

    server.resource("project-structure", projectStructureTemplate, async (uri, params) => {
        // *** DEFINE VARIABLES (like projectPath) ***
        const projectPathParam = params.project_path;
        if (typeof projectPathParam !== 'string') { return { contents: [{ uri: uri.href, text: `Error: Invalid project path type (${typeof projectPathParam}).`, contentType: "text/plain" }], isError: true }; }
        const projectPath: string = projectPathParam; // Define projectPath
        if (!projectPath) { return { contents: [{ uri: uri.href, text: "Error: Project path missing.", contentType: "text/plain" }], isError: true }; }
        // *** END DEFINE VARIABLES ***
        console.error(`Resource request: project structure for ${projectPath}`);
        try {
            const absoluteProjPath = path.normalize(path.isAbsolute(projectPath) ? projectPath : path.join(WORKSPACE_DIR, projectPath));
            const escapedPathForPython = absoluteProjPath.replace(/\\/g, '\\\\');
            // *** DEFINE scriptContent ***
            const scriptContent = GET_PROJECT_STRUCTURE_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedPathForPython);
            // *** END DEFINE scriptContent ***
            const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
            let structureText = `Error retrieving structure for ${absoluteProjPath}.\n\n${result.output}`; let isError = !result.success;
            if (result.success && result.output.includes("SCRIPT_SUCCESS")) {
                const startMarker = "--- PROJECT STRUCTURE START ---"; const endMarker = "--- PROJECT STRUCTURE END ---";
                const startIndex = result.output.indexOf(startMarker); const endIndex = result.output.indexOf(endMarker);
                if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
                     structureText = result.output.substring(startIndex + startMarker.length, endIndex).replace(/\\n/g, '\n').trim();
                 } else {
                    console.error("Error: Could not find structure markers in script output.");
                    structureText = `Could not parse structure markers in output for ${absoluteProjPath}.\n\nOutput:\n${result.output}`;
                    isError = true;
                }
            } else { isError = true; }
             // **** RETURN MCP STRUCTURE ****
            return { contents: [{ uri: uri.href, text: structureText, contentType: "text/plain" }], isError: isError };
        } catch (error: any) {
             console.error(`Error getting structure ${uri.href}:`, error);
             // **** RETURN MCP STRUCTURE ****
             return { contents: [{ uri: uri.href, text: `Failed structure script for '${projectPath}': ${error.message}`, contentType: "text/plain" }], isError: true };
        }
    });

    server.resource("pou-code", pouCodeTemplate, async (uri, params) => {
        // *** DEFINE VARIABLES (like projectPath, pouPath) ***
        const projectPathParam = params.project_path; const pouPathParam = params.pou_path;
        if (typeof projectPathParam !== 'string' || typeof pouPathParam !== 'string') { return { contents: [{ uri: uri.href, text: "Error: Invalid project or POU path type.", contentType: "text/plain" }], isError: true }; }
        const projectPath: string = projectPathParam; // Define projectPath
        const pouPath: string = pouPathParam; // Define pouPath
        if (!projectPath || !pouPath) { return { contents: [{ uri: uri.href, text: "Error: Project or POU path missing.", contentType: "text/plain" }], isError: true }; }
        // *** END DEFINE VARIABLES ***
        console.error(`Resource request: POU code: Project='${projectPath}', POU='${pouPath}'`);
        try {
            const absoluteProjPath = path.normalize(path.isAbsolute(projectPath) ? projectPath : path.join(WORKSPACE_DIR, projectPath));
            const sanitizedPouPath = String(pouPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            const escapedProjPath = absoluteProjPath.replace(/\\/g, '\\\\');
            // *** DEFINE scriptContent ***
            let scriptContent = GET_POU_CODE_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedProjPath);
            scriptContent = scriptContent.replace("{POU_FULL_PATH}", sanitizedPouPath);
            // *** END DEFINE scriptContent ***
            const result = await executeCodesysScript(scriptContent, codesysExePath, codesysProfileName);
            let codeText = `Error retrieving code for object '${sanitizedPouPath}' in project '${absoluteProjPath}'.\n\n${result.output}`; let isError = !result.success;
            if (result.success && result.output.includes("SCRIPT_SUCCESS")) {
                 // ... (marker parsing logic using new markers) ...
                 const declStartMarker = "### POU DECLARATION START ###";
                 const declEndMarker = "### POU DECLARATION END ###";
                 const implStartMarker = "### POU IMPLEMENTATION START ###";
                 const implEndMarker = "### POU IMPLEMENTATION END ###";

                 const declStartIdx = result.output.indexOf(declStartMarker);
                 const declEndIdx = result.output.indexOf(declEndMarker);
                 const implStartIdx = result.output.indexOf(implStartMarker);
                 const implEndIdx = result.output.indexOf(implEndMarker);

                let declaration = "/* Declaration not found in output */";
                let implementation = "/* Implementation not found in output */";
                 if (declStartIdx !== -1 && declEndIdx !== -1 && declStartIdx < declEndIdx) {
                     declaration = result.output.substring(declStartIdx + declStartMarker.length, declEndIdx).replace(/\\n/g, '\n').trim();
                 } else { console.error(`WARN: Declaration markers not found correctly for ${sanitizedPouPath}`); }
                 if (implStartIdx !== -1 && implEndIdx !== -1 && implStartIdx < implEndIdx) {
                    implementation = result.output.substring(implStartIdx + implStartMarker.length, implEndIdx).replace(/\\n/g, '\n').trim();
                 } else { console.error(`WARN: Implementation markers not found correctly for ${sanitizedPouPath}`); }
                 codeText = `// ----- Declaration -----\n${declaration}\n\n// ----- Implementation -----\n${implementation}`;
                 // *** END MARKER PARSING ***
            } else { isError = true; }
            // **** RETURN MCP STRUCTURE ****
            return { contents: [{ uri: uri.href, text: codeText, contentType: "text/plain" }], isError: isError };
        } catch (error: any) {
             console.error(`Error getting POU code ${uri.href}:`, error);
             // **** RETURN MCP STRUCTURE ****
             return { contents: [{ uri: uri.href, text: `Failed POU code script for '${pouPath}' in '${projectPath}': ${error.message}`, contentType: "text/plain" }], isError: true };
        }
    });
    // --- End Resources ---


    // --- Tools ---
    server.tool(
        "open_project", // Tool Name
        "Opens an existing CODESYS project file.", // Tool Description
        { // Input Schema
            filePath: z.string().describe("Path to the project file (e.g., 'C:/Projects/MyPLC.project' or '/Users/user/projects/my_project.project').")
        },
        async (args) => { // Handler
            const { filePath } = args;
            let absPath = path.normalize(path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_DIR, filePath));
            console.error(`Tool call: open_project: ${absPath}`);
            try {
                const escapedPath = absPath.replace(/\\/g, '\\\\');
                const script = OPEN_PROJECT_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedPath);
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                return { content: [{ type: "text", text: success ? `Project opened: ${absPath}` : `Failed open project ${absPath}. Output:\n${result.output}` }], isError: !success };
            } catch (e: any) {
                console.error(`Error open_project ${absPath}: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "create_project", // Tool Name
        "Creates a new CODESYS project from the standard template.", // Tool Description
        { // Input Schema
            filePath: z.string().describe("Path where the new project file should be created (e.g., 'C:/Projects/NewPLC.project' or '/Users/user/projects/new_project.project').")
        },
        async (args) => { // Handler
            const { filePath } = args;
            let absPath = path.normalize(path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_DIR, filePath));
            console.error(`Tool call: create_project (copy template): ${absPath}`);
            let templatePath = "";
            try {
                // Template finding logic (same as before)
                const baseDir = path.dirname(path.dirname(codesysExePath));
                templatePath = path.normalize(path.join(baseDir, 'Templates', 'Standard.project'));
                if (!(await fileExists(templatePath))) {
                    console.error(`WARN: Template not found relative to exe: ${templatePath}. Trying ProgramData...`);
                    const programData = process.env.ALLUSERSPROFILE || process.env.ProgramData || 'C:\\ProgramData';
                    const possibleTemplateDir = path.join(programData, 'CODESYS', 'CODESYS', codesysProfileName, 'Templates');
                    let potentialTemplatePath = path.normalize(path.join(possibleTemplateDir, 'Standard.project'));
                    if (await fileExists(potentialTemplatePath)) { templatePath = potentialTemplatePath; console.error(`DEBUG: Found template in ProgramData: ${templatePath}`); }
                    else {
                         const alternativeTemplateDir = path.join(programData, 'CODESYS', 'Templates');
                         potentialTemplatePath = path.normalize(path.join(alternativeTemplateDir, 'Standard.project'));
                         if (await fileExists(potentialTemplatePath)) { templatePath = potentialTemplatePath; console.error(`DEBUG: Found template in ProgramData (alternative): ${templatePath}`); }
                         else { throw new Error(`Standard template project file not found at relative path or ProgramData locations.`); }
                    }
                } else { console.error(`DEBUG: Found template relative to exe: ${templatePath}`); }
                // *** END TEMPLATE FINDING ***
            } catch (e:any) {
                console.error(`Template Error: ${e.message}`);
                return { content: [{ type: "text", text: `Template Error: ${e.message}` }], isError: true };
            }
            try {
                const escProjPath = absPath.replace(/\\/g, '\\\\'); const escTmplPath = templatePath.replace(/\\/g, '\\\\');
                const script = CREATE_PROJECT_SCRIPT_TEMPLATE
                    .replace("{PROJECT_FILE_PATH}", escProjPath)
                    .replace("{TEMPLATE_PROJECT_PATH}", escTmplPath);
                console.error(">>> create_project (copy-then-open): PREPARED SCRIPT:", script.substring(0, 500) + "...");
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                console.error(">>> create_project (copy-then-open): EXECUTION RESULT:", JSON.stringify(result));
                const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                return { content: [{ type: "text", text: success ? `Project created from template: ${absPath}` : `Failed create project ${absPath} from template. Output:\n${result.output}` }], isError: !success };
            } catch (e: any) {
                console.error(`Error create_project ${absPath}: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "save_project", // Tool Name
        "Saves the currently open CODESYS project.", // Tool Description
        { // Input Schema
            projectFilePath: z.string().describe("Path to the project file to ensure is open before saving (e.g., 'C:/Projects/MyPLC.project').")
        },
        async (args) => { // Handler
            const { projectFilePath } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            console.error(`Tool call: save_project: ${absPath}`);
            try {
                const escapedPath = absPath.replace(/\\/g, '\\\\');
                const script = SAVE_PROJECT_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedPath);
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                return { content: [{ type: "text", text: success ? `Project saved: ${absPath}` : `Failed save project ${absPath}. Output:\n${result.output}` }], isError: !success };
            } catch (e:any) {
                console.error(`Error save_project ${absPath}: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "create_pou", // Tool Name
        "Creates a new Program, Function Block, or Function POU within the specified CODESYS project.", // Tool Description
        { // Input Schema
            projectFilePath: z.string().describe("Path to the project file (e.g., 'C:/Projects/MyPLC.project')."),
            name: z.string().describe("Name for the new POU (must be a valid IEC identifier)."),
            type: PouTypeEnum.describe("Type of POU (Program, FunctionBlock, Function)."),
            language: ImplementationLanguageEnum.describe("Implementation language (ST, LD, FBD, etc.). CODESYS default will be used if specific language is not set or directly supported by scripting for this POU type."),
            parentPath: z.string().describe("Relative path under project root or application where the POU should be created (e.g., 'Application' or 'MyFolder/SubFolder').")
        },
        async (args) => { // Handler
            const { projectFilePath, name, type, language, parentPath } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            const sanParentPath = parentPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            const sanName = name.trim();

            console.error(`Tool call: create_pou: Name='${sanName}', Type='${type}', Lang='${language}', Parent='${sanParentPath}', Project='${absPath}'`);
            try {
                const escProjPath = absPath.replace(/\\/g, '\\\\');
                let script = CREATE_POU_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProjPath);
                script = script.replace("{POU_NAME}", sanName);
                script = script.replace("{POU_TYPE_STR}", type);
                script = script.replace("{IMPL_LANGUAGE_STR}", language);
                script = script.replace("{PARENT_PATH}", sanParentPath);

                console.error(">>> create_pou: PREPARED SCRIPT:", script.substring(0,500)+"...");
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                console.error(">>> create_pou: EXECUTION RESULT:", JSON.stringify(result));
                const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                return { content: [{ type: "text", text: success ? `POU '${sanName}' created in '${sanParentPath}' of ${absPath}. Project saved.` : `Failed create POU '${sanName}'. Output:\n${result.output}` }], isError: !success };
            } catch (e:any) {
                console.error(`Error create_pou ${sanName} in ${absPath}: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(

        "create_gvl", // Tool Name

        "Creates a REAL Global Variable List (GVL) object under the given parent (default 'Application'), optionally setting its full textual declaration (VAR_GLOBAL ... END_VAR). Use this for global variables and catalog-instance declarations — a GVL is NOT a Program, so do NOT use create_pou for it. Reuses an existing GVL of the same name if present (idempotent).", // Tool Description

        { // Input Schema

            projectFilePath: z.string().describe("Path to the project file (e.g., 'C:/Projects/MyPLC.project')."),

            name: z.string().describe("Name for the GVL (valid IEC identifier). Defaults to 'GVL'.").optional(),

            parentPath: z.string().describe("Relative path of the container to create the GVL under (e.g. 'Application' or 'Application/GVLs'). Defaults to 'Application'.").optional(),

            declaration: z.string().describe("Optional full textual declaration block, e.g. 'VAR_GLOBAL\\n\\tG1 : TYP_BIN;\\n\\tN1 : TYP_IDF1;\\nEND_VAR'. If omitted, an empty GVL is created.").optional()

        },

        async (args) => { // Handler

            const { projectFilePath, name, parentPath, declaration } = args;

            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));

            const sanName = (name ?? "GVL").trim();

            const sanParentPath = (parentPath ?? "Application").replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

            console.error(`Tool call: create_gvl: Name='${sanName}', Parent='${sanParentPath}', Project='${absPath}'`);

            if (!sanName) {

                return { content: [{ type: "text", text: `Error: GVL name cannot be empty.` }], isError: true };

            }

            try {

                const escProjPath = absPath.replace(/\\/g, '\\\\');

                // Escape content for Python triple-quoted string (same approach as set_pou_code).

                const sanDecl = (declaration ?? "").replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');

                let script = CREATE_GVL_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProjPath);

                script = script.replace("{GVL_NAME}", sanName);

                script = script.replace("{PARENT_PATH}", sanParentPath);

                script = script.replace("{DECLARATION_CONTENT}", sanDecl);

                script = script.replace("{SET_DECL}", declaration !== undefined ? "True" : "False");



                console.error(">>> create_gvl: PREPARED SCRIPT:", script.substring(0, 500) + "...");

                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);

                console.error(">>> create_gvl: EXECUTION RESULT:", JSON.stringify(result));

                const success = result.success && result.output.includes("SCRIPT_SUCCESS");

                return { content: [{ type: "text", text: success ? `GVL '${sanName}' created under '${sanParentPath}' in ${absPath}. Project saved.` : `Failed to create GVL '${sanName}'. Output:\n${result.output}` }], isError: !success };

            } catch (e:any) {

                console.error(`Error create_gvl ${sanName} in ${absPath}: ${e}`);

                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };

            }

        }

    );

    server.tool(
        "add_library_reference", // Tool Name
        "Adds a library reference to the project's Library Manager so catalog blocks resolve (e.g. TYP_IDF1/TYP_BIN/TYP_AIN from Grundfunktionen.library). Provide libraryName (a library already installed in a repository) and/or libraryFilePath (a .library file on disk, which is installed first). Idempotent: skips if already referenced. Building block for template-free scaffolding.", // Description
        { // Input Schema
            projectFilePath: z.string().describe("Path to the .project file."),
            libraryName: z.string().describe("Name of the library to reference, e.g. 'Grundfunktionen'. Used to look up an already-installed library and to skip if already referenced.").optional(),
            libraryFilePath: z.string().describe("Path to a .library file on disk. If given and the library is not found by name, it is installed into the first repository, then referenced.").optional(),
            asPlaceholder: z.boolean().optional().describe("Add as a version placeholder instead of a fixed reference. Defaults to false."),
            placeholderName: z.string().optional().describe("Placeholder name (defaults to the library display name) when asPlaceholder is true.")
        },
        async (args) => { // Handler
            const { projectFilePath, libraryName, libraryFilePath, asPlaceholder, placeholderName } = args;
            if (!libraryName && !libraryFilePath) {
                return { content: [{ type: "text", text: "Error: provide libraryName and/or libraryFilePath." }], isError: true };
            }
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            const absLib = libraryFilePath ? path.normalize(path.isAbsolute(libraryFilePath) ? libraryFilePath : path.join(WORKSPACE_DIR, libraryFilePath)) : "";
            console.error(`Tool call: add_library_reference: name='${libraryName ?? ''}', file='${absLib}', project='${absPath}'`);
            try {
                const escProj = absPath.replace(/\\/g, '\\\\');
                let script = ADD_LIBRARY_REFERENCE_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProj);
                script = script.replace("{LIB_NAME}", (libraryName ?? "").trim());
                script = script.replace("{LIB_FILEPATH}", absLib.replace(/\\/g, '\\\\'));
                script = script.replace("{AS_PLACEHOLDER}", asPlaceholder ? "True" : "False");
                script = script.replace("{PLACEHOLDER_NAME}", (placeholderName ?? "").trim());
                console.error(">>> add_library_reference: PREPARED SCRIPT:", script.substring(0, 400) + "...");
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                console.error(">>> add_library_reference: EXECUTION RESULT:", JSON.stringify(result));
                const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                return { content: [{ type: "text", text: success ? `Library reference added to ${absPath} (name='${libraryName ?? ''}', file='${absLib}'). Project saved.` : `Failed to add library reference. Output:\n${result.output}` }], isError: !success };
            } catch (e:any) {
                console.error(`Error add_library_reference in ${absPath}: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "set_pou_code", // Tool Name
        "Sets the declaration and/or implementation code for a specific POU, Method, or Property.", // Tool Description
        { // Input Schema
            projectFilePath: z.string().describe("Path to the project file (e.g., 'C:/Projects/MyPLC.project')."),
            pouPath: z.string().describe("Full relative path to the target object (e.g., 'Application/MyPOU', 'MyFolder/MyFB/MyMethod', 'MyFolder/MyFB/MyProperty')."),
            declarationCode: z.string().describe("Code for the declaration part (VAR...END_VAR). If omitted, the declaration is not changed.").optional(),
            implementationCode: z.string().describe("Code for the implementation logic part. If omitted, the implementation is not changed.").optional()
        },
        async (args) => { // Handler
            const { projectFilePath, pouPath, declarationCode, implementationCode } = args;
            if (declarationCode === undefined && implementationCode === undefined) {
                return { content: [{ type: "text", text: "Error: At least one of declarationCode or implementationCode must be provided." }], isError: true };
            }
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            const sanPouPath = pouPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            console.error(`Tool call: set_pou_code: Target='${sanPouPath}', Project='${absPath}'`);
            try {
                const escProjPath = absPath.replace(/\\/g, '\\\\');
                // Escape content for Python triple-quoted strings
                const sanDeclCode = (declarationCode ?? "").replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
                const sanImplCode = (implementationCode ?? "").replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
                let script = SET_POU_CODE_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProjPath);
                script = script.replace("{POU_FULL_PATH}", sanPouPath);
                script = script.replace("{DECLARATION_CONTENT}", sanDeclCode);
                script = script.replace("{IMPLEMENTATION_CONTENT}", sanImplCode);
                script = script.replace("{SET_DECL}", declarationCode !== undefined ? "True" : "False");
                script = script.replace("{SET_IMPL}", implementationCode !== undefined ? "True" : "False");

                console.error(">>> set_pou_code: PREPARED SCRIPT:", script.substring(0, 500) + "...");
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                console.error(">>> set_pou_code: EXECUTION RESULT:", JSON.stringify(result));
                const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                return { content: [{ type: "text", text: success ? `Code set for '${sanPouPath}' in ${absPath}. Project saved.` : `Failed set code for '${sanPouPath}'. Output:\n${result.output}` }], isError: !success };
            } catch (e:any) {
                console.error(`Error set_pou_code ${sanPouPath} in ${absPath}: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "create_property", // Tool Name
        "Creates a new Property within a specific Function Block POU.", // Tool Description
        { // Input Schema
            projectFilePath: z.string().describe("Path to the project file (e.g., 'C:/Projects/MyPLC.project')."),
            // Assuming properties can only be added to FBs in standard CODESYS scripting
            parentPouPath: z.string().describe("Relative path to the parent Function Block POU (e.g., 'Application/MyFB')."),
            propertyName: z.string().describe("Name for the new property (must be a valid IEC identifier)."),
            propertyType: z.string().describe("Data type of the property (e.g., 'BOOL', 'INT', 'MyDUT').")
        },
        async (args) => { // Handler
            const { projectFilePath, parentPouPath, propertyName, propertyType } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            const sanParentPath = parentPouPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            const sanPropName = propertyName.trim();
            const sanPropType = propertyType.trim();
            console.error(`Tool call: create_property: Name='${sanPropName}', Type='${sanPropType}', ParentPOU='${sanParentPath}', Project='${absPath}'`);
            if (!sanPropName || !sanPropType) {
                return { content: [{ type: "text", text: `Error: Property name and type cannot be empty.` }], isError: true };
            }
            try {
                const escProjPath = absPath.replace(/\\/g, '\\\\');
                let script = CREATE_PROPERTY_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProjPath);
                script = script.replace("{PARENT_POU_FULL_PATH}", sanParentPath);
                script = script.replace("{PROPERTY_NAME}", sanPropName);
                script = script.replace("{PROPERTY_TYPE}", sanPropType);

                console.error(">>> create_property: PREPARED SCRIPT:", script.substring(0, 500) + "...");
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                console.error(">>> create_property: EXECUTION RESULT:", JSON.stringify(result));
                const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                return {
                    content: [{ type: "text", text: success ? `Property '${sanPropName}' created under '${sanParentPath}' in ${absPath}. Project saved.` : `Failed to create property '${sanPropName}'. Output:\n${result.output}` }],
                    isError: !success
                };
            } catch (e: any) {
                console.error(`Error create_property ${sanPropName} in ${absPath}: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "create_method", // Tool Name
        "Creates a new Method within a specific Function Block POU.", // Tool Description
        { // Input Schema
            projectFilePath: z.string().describe("Path to the project file (e.g., 'C:/Projects/MyPLC.project')."),
            // Assuming methods can typically only be added to FBs in standard CODESYS scripting
            parentPouPath: z.string().describe("Relative path to the parent Function Block POU (e.g., 'Application/MyFB')."),
            methodName: z.string().describe("Name of the new method (must be a valid IEC identifier)."),
            returnType: z.string().optional().describe("Return type (e.g., 'BOOL', 'INT'). Leave empty or omit for no return value (PROCEDURE)."),
        },
        async (args) => { // Handler
            const { projectFilePath, parentPouPath, methodName, returnType } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            const sanParentPath = parentPouPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            const sanMethName = methodName.trim();
            const sanReturnType = (returnType ?? "").trim();
            console.error(`Tool call: create_method: Name='${sanMethName}', Return='${sanReturnType}', ParentPOU='${sanParentPath}', Project='${absPath}'`);
            if (!sanMethName) {
                return { content: [{ type: "text", text: `Error: Method name cannot be empty.` }], isError: true };
            }
            try {
                const escProjPath = absPath.replace(/\\/g, '\\\\');
                let script = CREATE_METHOD_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProjPath);
                script = script.replace("{PARENT_POU_FULL_PATH}", sanParentPath);
                script = script.replace("{METHOD_NAME}", sanMethName);
                script = script.replace("{RETURN_TYPE}", sanReturnType);

                console.error(">>> create_method: PREPARED SCRIPT:", script.substring(0, 500) + "...");
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                console.error(">>> create_method: EXECUTION RESULT:", JSON.stringify(result));
                const success = result.success && result.output.includes("SCRIPT_SUCCESS");
                return {
                    content: [{ type: "text", text: success ? `Method '${sanMethName}' created under '${sanParentPath}' in ${absPath}. Project saved.` : `Failed to create method '${sanMethName}'. Output:\n${result.output}` }],
                    isError: !success
                };
            } catch (e: any) {
                console.error(`Error create_method ${sanMethName} in ${absPath}: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "compile_project", // Tool Name
        "Compiles (Builds) the primary application within a CODESYS project.", // Tool Description
        { // Input Schema
            projectFilePath: z.string().describe("Path to the project file containing the application to compile (e.g., 'C:/Projects/MyPLC.project').")
        },
        async (args) => { // Handler
            const { projectFilePath } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            console.error(`Tool call: compile_project: ${absPath}`);
            try {
                const escapedPath = absPath.replace(/\\/g, '\\\\');
                const script = COMPILE_PROJECT_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escapedPath);
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                const scriptSucceeded = result.success && result.output.includes("SCRIPT_SUCCESS");
                // Parse the structured build result emitted by the compile script.
                const errMatch = result.output.match(/Errors:\s*(\d+)/);
                const warnMatch = result.output.match(/Warnings:\s*(\d+)/);
                const errorCount: number | null = errMatch ? parseInt(errMatch[1], 10) : null;
                const warningCount: number | null = warnMatch ? parseInt(warnMatch[1], 10) : null;
                // Extract the detail lines (individual errors/warnings) between the markers.
                let details = "";
                const startMarker = "--- BUILD RESULT START ---";
                const endMarker = "--- BUILD RESULT END ---";
                const sIdx = result.output.indexOf(startMarker);
                const eIdx = result.output.indexOf(endMarker);
                if (sIdx !== -1 && eIdx !== -1 && sIdx < eIdx) {
                    details = result.output.substring(sIdx + startMarker.length, eIdx)
                        .split(/[\r\n]+/).filter((l: string) => /^(ERROR|WARNING):/.test(l.trim())).join("\n");
                }
                let isError = !scriptSucceeded || (errorCount !== null && errorCount > 0);
                let message: string;
                if (errorCount !== null) {
                    message = (errorCount > 0)
                        ? `Build FAILED for ${absPath}: ${errorCount} error(s), ${warningCount} warning(s).`
                        : `Build succeeded for ${absPath}: ${errorCount} error(s), ${warningCount} warning(s).`;
                    if (details)
                        message += `\n\n${details}`;
                } else {
                    // Fallback: build messages could not be parsed (e.g. message store unavailable).
                    message = scriptSucceeded
                        ? `Compilation completed for ${absPath}, but build results could not be parsed. Output:\n${result.output}`
                        : `Failed compiling ${absPath}. Output:\n${result.output}`;
                }
                return { content: [{ type: "text", text: message }], isError: isError };
            } catch (e:any) {
                console.error(`Error compile_project ${absPath}: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "import_plcopenxml", // Tool Name
        "Imports a PLCopenXML (.xml) file into a CODESYS project, either at the project top level or as children of a target object/folder. Returns the number of added objects plus any errors/warnings.", // Tool Description
        { // Input Schema
            projectFilePath: z.string().describe("Path to the project file (e.g., 'C:/Projects/MyPLC.project')."),
            xmlFilePath: z.string().describe("Path to the PLCopenXML (.xml) file to import (e.g., 'C:/Exports/MyPou.xml')."),
            targetPath: z.string().optional().describe("Optional relative path of the object or folder to import INTO (e.g., 'Application' or 'Application/MyFolder'). If omitted, objects are imported at the project top level."),
            importFolderStructure: z.boolean().optional().describe("If true, also import the (proprietary) folder structure extension. Defaults to false."),
            conflictResolution: z.enum(["Replace", "Copy", "Skip"]).optional().describe("How to resolve conflicts when an imported object already exists: Replace (overwrite, default), Copy (keep both), or Skip (keep existing).")
        },
        async (args) => { // Handler
            const { projectFilePath, xmlFilePath, targetPath, importFolderStructure, conflictResolution } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            let absXmlPath = path.normalize(path.isAbsolute(xmlFilePath) ? xmlFilePath : path.join(WORKSPACE_DIR, xmlFilePath));
            const sanTarget = (targetPath ?? "").replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            const folderStruct = importFolderStructure ? "True" : "False";
            const conflict = conflictResolution ?? "Replace";
            console.error(`Tool call: import_plcopenxml: XML='${absXmlPath}', Target='${sanTarget}', Conflict='${conflict}', Project='${absPath}'`);
            try {
                if (!(await fileExists(absXmlPath))) {
                    return { content: [{ type: "text", text: `Error: PLCopenXML file not found: ${absXmlPath}` }], isError: true };
                }
                const escProjPath = absPath.replace(/\\/g, '\\\\');
                const escXmlPath = absXmlPath.replace(/\\/g, '\\\\');
                let script = IMPORT_XML_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProjPath);
                script = script.replace("{XML_FILE_PATH}", escXmlPath);
                script = script.replace("{TARGET_PATH}", sanTarget);
                script = script.replace("{IMPORT_FOLDER_STRUCTURE}", folderStruct);
                script = script.replace("{CONFLICT_RESOLVE}", conflict);
                console.error(">>> import_plcopenxml: PREPARED SCRIPT:", script.substring(0, 500) + "...");
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                console.error(">>> import_plcopenxml: EXECUTION RESULT:", JSON.stringify(result));
                const scriptSucceeded = result.success && result.output.includes("SCRIPT_SUCCESS");
                // Parse the structured import result.
                const addedMatch = result.output.match(/Added:\s*(\d+)/);
                const errMatch = result.output.match(/Errors:\s*(\d+)/);
                const warnMatch = result.output.match(/Warnings:\s*(\d+)/);
                const addedCount: number | null = addedMatch ? parseInt(addedMatch[1], 10) : null;
                const errorCount: number | null = errMatch ? parseInt(errMatch[1], 10) : null;
                const warningCount: number | null = warnMatch ? parseInt(warnMatch[1], 10) : null;
                let details = "";
                const startMarker = "--- IMPORT RESULT START ---";
                const endMarker = "--- IMPORT RESULT END ---";
                const sIdx = result.output.indexOf(startMarker);
                const eIdx = result.output.indexOf(endMarker);
                if (sIdx !== -1 && eIdx !== -1 && sIdx < eIdx) {
                    details = result.output.substring(sIdx + startMarker.length, eIdx)
                        .split(/[\r\n]+/).filter((l: string) => /^(ERROR|WARNING):/.test(l.trim())).join("\n");
                }
                let isError = !scriptSucceeded || (errorCount !== null && errorCount > 0);
                let message: string;
                if (addedCount !== null || errorCount !== null) {
                    message = isError
                        ? `PLCopenXML import FAILED for ${absXmlPath}: ${errorCount ?? '?'} error(s), ${warningCount ?? '?'} warning(s).`
                        : `PLCopenXML imported into ${absPath}: ${addedCount ?? '?'} object(s) added, ${warningCount ?? 0} warning(s). Project saved.`;
                    if (details)
                        message += `\n\n${details}`;
                } else {
                    message = scriptSucceeded
                        ? `PLCopenXML import completed for ${absPath}, but results could not be parsed. Output:\n${result.output}`
                        : `Failed importing PLCopenXML '${absXmlPath}'. Output:\n${result.output}`;
                }
                return { content: [{ type: "text", text: message }], isError: isError };
            } catch (e:any) {
                console.error(`Error import_plcopenxml ${absXmlPath} into ${absPath}: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );
    server.tool(
        "cfc_add_device", // Tool Name
        "Adds a new device control program (CFC) to a CODESYS project by CLONING a template device CFC (.export) and rebinding it: program name, bound global FB instance (auto-declared in the GVL), a fresh object GUID, and optionally an interlock operand. Optionally builds and verifies. This is the headless-safe way to create device CFCs — hand-authored CFC loses its wiring on import.", // Description
        { // Input Schema
            projectFilePath: z.string().describe("Path to the .project file (e.g. 'C:/Projects/Plant.project')."),
            templatePath: z.string().describe("Path to a source device CFC .export to clone (e.g. a motor/valve/sensor/controller template such as an Insulin-reference NS101.export)."),
            newName: z.string().describe("Name of the new device program, e.g. 'NS_N5'."),
            newInstance: z.string().describe("Name of the new global FB instance to bind, e.g. 'N5'. Declared in the GVL if missing."),
            instanceType: z.string().optional().describe("FB type for the GVL declaration, e.g. 'TYP_IDF1'. If omitted, taken from the template's BoxType."),
            targetFolder: z.string().optional().describe("Folder to import the program into. Defaults to 'CFCs'."),
            gvlName: z.string().optional().describe("Global variable list to declare the instance in. Defaults to 'GVL'."),
            interlock: z.string().optional().describe("Optional operand for the first lock input (e.g. 'L104.SL'). If omitted, the template's value is kept."),
            rebind: z.array(z.string()).optional().describe("Extra operand rebinds, each as 'old=new' (e.g. for a controller's driven actuator: 'Y103=Y5'). Applied to box operand values after the instance rebind."),
            build: z.boolean().optional().describe("Build the application and report errors afterwards. Defaults to true.")
        },
        async (args) => { // Handler
            const { projectFilePath, templatePath, newName, newInstance, instanceType, targetFolder, gvlName, interlock, rebind, build } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            let absTmpl = path.normalize(path.isAbsolute(templatePath) ? templatePath : path.join(WORKSPACE_DIR, templatePath));
            const doBuild = (build === false) ? "False" : "True";
            console.error(`Tool call: cfc_add_device: tmpl='${absTmpl}', new='${newName}', inst='${newInstance}', project='${absPath}'`);
            try {
                if (!(await fileExists(absTmpl))) {
                    return { content: [{ type: "text", text: `Error: template export not found: ${absTmpl}` }], isError: true };
                }
                const escProj = absPath.replace(/\\/g, '\\\\');
                const escTmpl = absTmpl.replace(/\\/g, '\\\\');
                let script = CFC_ADD_DEVICE_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProj);
                script = script.replace("{TEMPLATE_PATH}", escTmpl);
                script = script.replace("{NEW_NAME}", newName);
                script = script.replace("{NEW_INSTANCE}", newInstance);
                script = script.replace("{INSTANCE_TYPE}", instanceType ?? "");
                script = script.replace("{TARGET_FOLDER}", targetFolder ?? "CFCs");
                script = script.replace("{GVL_NAME}", gvlName ?? "GVL");
                script = script.replace("{INTERLOCK}", interlock ?? "");
                script = script.replace("{REBIND}", JSON.stringify(rebind ?? []));
                script = script.replace("{DO_BUILD}", doBuild);
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                const scriptSucceeded = result.success && result.output.includes("SCRIPT_SUCCESS");
                const addedMatch = result.output.match(/Added:\s*(\d+)/);
                const errMatch = result.output.match(/Errors:\s*(\d+)/);
                const warnMatch = result.output.match(/Warnings:\s*(\d+)/);
                const verifyMatch = result.output.match(/Verify:\s*box=(\w+)\s+instance=(\w+)/);
                const addedCount: number | null = addedMatch ? parseInt(addedMatch[1], 10) : null;
                const errorCount: number | null = errMatch ? parseInt(errMatch[1], 10) : null;
                const warningCount: number | null = warnMatch ? parseInt(warnMatch[1], 10) : null;
                let details = "";
                const startMarker = "--- CFC RESULT START ---";
                const endMarker = "--- CFC RESULT END ---";
                const sIdx = result.output.indexOf(startMarker);
                const eIdx = result.output.indexOf(endMarker);
                if (sIdx !== -1 && eIdx !== -1 && sIdx < eIdx) {
                    details = result.output.substring(sIdx, eIdx + endMarker.length);
                }
                const isError = !scriptSucceeded || (errorCount !== null && errorCount > 0) || (addedCount !== null && addedCount < 1);
                let message: string;
                if (addedCount !== null) {
                    const verify = verifyMatch ? ` Verify: box=${verifyMatch[1]}, instance=${verifyMatch[2]}.` : "";
                    message = isError
                        ? `cfc_add_device FAILED for '${newName}': ${errorCount ?? '?'} error(s), added=${addedCount}.${verify}`
                        : `Device '${newName}' (instance ${newInstance}) added as CFC: ${errorCount ?? 0} error(s), ${warningCount ?? 0} warning(s).${verify} Project saved.`;
                    if (details) message += `\n\n${details}`;
                } else {
                    message = scriptSucceeded
                        ? `cfc_add_device completed but results could not be parsed. Output:\n${result.output}`
                        : `cfc_add_device failed. Output:\n${result.output}`;
                }
                return { content: [{ type: "text", text: message }], isError: isError };
            } catch (e:any) {
                console.error(`Error cfc_add_device: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );
    server.tool(
        "catalog_list", // Tool Name
        "Lists the objects (POUs/FBs/interfaces/GVLs/folders) in a CODESYS project or library (.project or .library), with each object's first declaration line. Use to inspect/verify a block catalog. By default skips members (methods/properties); set includeMembers to include them.", // Description
        { // Input Schema
            targetPath: z.string().describe("Path to the .project or .library file to enumerate."),
            includeMembers: z.boolean().optional().describe("If true, also list methods/properties/accessors. Defaults to false (compact, types only).")
        },
        async (args) => { // Handler
            const { targetPath, includeMembers } = args;
            let absPath = path.normalize(path.isAbsolute(targetPath) ? targetPath : path.join(WORKSPACE_DIR, targetPath));
            console.error(`Tool call: catalog_list: ${absPath} (members=${!!includeMembers})`);
            try {
                if (!(await fileExists(absPath))) {
                    return { content: [{ type: "text", text: `Error: file not found: ${absPath}` }], isError: true };
                }
                const escPath = absPath.replace(/\\/g, '\\\\');
                let script = CATALOG_LIST_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escPath);
                script = script.replace("{INCLUDE_MEMBERS}", includeMembers ? "True" : "False");
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                const scriptSucceeded = result.success && result.output.includes("SCRIPT_SUCCESS");
                const countMatch = result.output.match(/Count:\s*(\d+)/);
                const count = countMatch ? parseInt(countMatch[1], 10) : null;
                let listing = "";
                const sIdx = result.output.indexOf("--- CATALOG START ---");
                const eIdx = result.output.indexOf("--- CATALOG END ---");
                if (sIdx !== -1 && eIdx !== -1 && sIdx < eIdx) {
                    listing = result.output.substring(sIdx + "--- CATALOG START ---".length, eIdx).trim();
                }
                let message: string;
                if (scriptSucceeded) {
                    message = `Catalog of ${absPath}${count !== null ? ` (${count} item(s))` : ''}:\n\n${listing}`;
                } else {
                    message = `catalog_list failed for ${absPath}. Output:\n${result.output}`;
                }
                return { content: [{ type: "text", text: message }], isError: !scriptSucceeded };
            } catch (e:any) {
                console.error(`Error catalog_list ${absPath}: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "sim_run", // Tool Name
        "Runs the primary application of a CODESYS project in headless SIMULATION: optionally builds, logs in to the simulated device, starts it, optionally forces variables, reads back variable values, then stops and logs out (cleanly). The project must NOT be open in a CODESYS GUI. Returns the run state and the requested variable values.", // Description
        { // Input Schema
            projectFilePath: z.string().describe("Path to the .project file."),
            readVariables: z.array(z.string()).optional().describe("Variables to read after start, e.g. ['GVL.L104.PV','PLC_PRG.Anlage']."),
            forceVariables: z.array(z.string()).optional().describe("Variables to force before reading, each as 'expr=value' (e.g. 'GVL.N101.MANUAL=TRUE')."),
            runSeconds: z.number().optional().describe("Seconds to let the simulation run before reading. Defaults to 2."),
            build: z.boolean().optional().describe("Build before simulating. Defaults to true.")
        },
        async (args) => { // Handler
            const { projectFilePath, readVariables, forceVariables, runSeconds, build } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            const readPy = JSON.stringify(readVariables ?? []);
            const forcePy = JSON.stringify(forceVariables ?? []);
            const runSecs = (typeof runSeconds === 'number' && runSeconds >= 0) ? String(runSeconds) : "2";
            const doBuild = (build === false) ? "False" : "True";
            console.error(`Tool call: sim_run: ${absPath} read=${readPy} force=${forcePy} secs=${runSecs}`);
            try {
                const escPath = absPath.replace(/\\/g, '\\\\');
                let script = SIM_RUN_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escPath);
                script = script.replace("{READ_VARS}", readPy);
                script = script.replace("{FORCE_VARS}", forcePy);
                script = script.replace("{RUN_SECONDS}", runSecs);
                script = script.replace("{DO_BUILD}", doBuild);
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                const scriptSucceeded = result.success && result.output.includes("SCRIPT_SUCCESS");
                const stateMatch = result.output.match(/State:\s*(\w+)/);
                let block = "";
                const sIdx = result.output.indexOf("--- SIM RESULT START ---");
                const eIdx = result.output.indexOf("--- SIM RESULT END ---");
                if (sIdx !== -1 && eIdx !== -1 && sIdx < eIdx) {
                    block = result.output.substring(sIdx, eIdx + "--- SIM RESULT END ---".length);
                }
                const isError = !scriptSucceeded;
                let message: string;
                if (block) {
                    message = isError
                        ? `sim_run did not reach 'run' for ${absPath} (state=${stateMatch ? stateMatch[1] : '?'}).\n\n${block}`
                        : `Simulation ran for ${absPath} (state=${stateMatch ? stateMatch[1] : '?'}).\n\n${block}`;
                } else {
                    message = scriptSucceeded
                        ? `sim_run completed but results could not be parsed. Output:\n${result.output}`
                        : `sim_run failed for ${absPath}. Output:\n${result.output}`;
                }
                return { content: [{ type: "text", text: message }], isError: isError };
            } catch (e:any) {
                console.error(`Error sim_run ${absPath}: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );
    server.tool(
        "scaffold_plant", // Tool Name
        "Scaffolds a new CODESYS plant project by cloning a known-good skeleton (retargeted device, referenced catalog library, empty GVL, CFCs/SFCs folders, task-bound PLC_PRG orchestrator), then builds and verifies it. The result is a buildable project ready to fill with cfc_add_device. Use this to start a project from scratch.", // Description
        { // Input Schema
            projectFilePath: z.string().describe("Path for the NEW project to create (e.g. 'C:/Projects/Beer.project')."),
            skeletonPath: z.string().describe("Path to the skeleton .project to clone (the prepared base; e.g. the bundle's skeleton/skeleton.project)."),
            overwrite: z.boolean().optional().describe("If true, replace an existing project at projectFilePath. Defaults to false."),
            build: z.boolean().optional().describe("Build and verify the scaffolded project. Defaults to true.")
        },
        async (args) => { // Handler
            const { projectFilePath, skeletonPath, overwrite, build } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            let absSkel = path.normalize(path.isAbsolute(skeletonPath) ? skeletonPath : path.join(WORKSPACE_DIR, skeletonPath));
            const doBuild = (build === false) ? "False" : "True";
            const doOverwrite = overwrite ? "True" : "False";
            console.error(`Tool call: scaffold_plant: target='${absPath}', skeleton='${absSkel}'`);
            try {
                if (!(await fileExists(absSkel))) {
                    return { content: [{ type: "text", text: `Error: skeleton project not found: ${absSkel}` }], isError: true };
                }
                const escTarget = absPath.replace(/\\/g, '\\\\');
                const escSkel = absSkel.replace(/\\/g, '\\\\');
                let script = SCAFFOLD_PLANT_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escTarget);
                script = script.replace("{SKELETON_PATH}", escSkel);
                script = script.replace("{OVERWRITE}", doOverwrite);
                script = script.replace("{DO_BUILD}", doBuild);
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                const scriptSucceeded = result.success && result.output.includes("SCRIPT_SUCCESS");
                const errMatch = result.output.match(/Errors:\s*(\d+)/);
                const warnMatch = result.output.match(/Warnings:\s*(\d+)/);
                const structMatch = result.output.match(/Structure:\s*([^\r\n]+)/);
                const errorCount: number | null = errMatch ? parseInt(errMatch[1], 10) : null;
                const warningCount: number | null = warnMatch ? parseInt(warnMatch[1], 10) : null;
                const isError = !scriptSucceeded || (errorCount !== null && errorCount > 0);
                let message: string;
                if (errorCount !== null) {
                    const struct = structMatch ? ` Structure: ${structMatch[1].trim()}.` : "";
                    message = isError
                        ? `scaffold_plant FAILED for ${absPath}: ${errorCount} error(s), ${warningCount ?? '?'} warning(s).${struct}`
                        : `Plant scaffolded at ${absPath}: builds with ${errorCount} error(s), ${warningCount ?? 0} warning(s).${struct} Ready for cfc_add_device.`;
                } else {
                    message = scriptSucceeded
                        ? `Plant scaffolded at ${absPath} (build skipped or results unparsed). Output:\n${result.output}`
                        : `scaffold_plant failed for ${absPath}. Output:\n${result.output}`;
                }
                return { content: [{ type: "text", text: message }], isError: isError };
            } catch (e:any) {
                console.error(`Error scaffold_plant ${absPath}: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );
    server.tool(
        "set_orchestrator", // Tool Name
        "Sets the body of the task-bound orchestrator program (PLC_PRG by default) to call the given device/sub-programs in order, e.g. ['NS_N1','YS_Y1'] becomes 'NS_N1();' + 'YS_Y1();'. Sets ONLY the implementation, never the declaration, so the task binding stays intact (avoids the 'PLC_PRG nicht definiert' breakage). Optionally builds and verifies.", // Description
        { // Input Schema
            projectFilePath: z.string().describe("Path to the .project file."),
            calls: z.array(z.string()).describe("Program names to call in order (without parentheses), e.g. ['NS_N1','YS_Y1','AI_A1']."),
            pouName: z.string().optional().describe("Name of the orchestrator POU. Defaults to 'PLC_PRG'."),
            build: z.boolean().optional().describe("Build and verify afterwards. Defaults to true.")
        },
        async (args) => { // Handler
            const { projectFilePath, calls, pouName, build } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            const doBuild = (build === false) ? "False" : "True";
            console.error(`Tool call: set_orchestrator: ${absPath} pou=${pouName ?? 'PLC_PRG'} calls=${JSON.stringify(calls)}`);
            try {
                const escProj = absPath.replace(/\\/g, '\\\\');
                let script = SET_ORCHESTRATOR_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProj);
                script = script.replace("{POU_NAME}", pouName ?? "PLC_PRG");
                script = script.replace("{CALLS}", JSON.stringify(calls ?? []));
                script = script.replace("{DO_BUILD}", doBuild);
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                const scriptSucceeded = result.success && result.output.includes("SCRIPT_SUCCESS");
                const callsMatch = result.output.match(/Calls:\s*(\d+)/);
                const errMatch = result.output.match(/Errors:\s*(\d+)/);
                const warnMatch = result.output.match(/Warnings:\s*(\d+)/);
                const callCount = callsMatch ? parseInt(callsMatch[1], 10) : null;
                const errorCount: number | null = errMatch ? parseInt(errMatch[1], 10) : null;
                const warningCount: number | null = warnMatch ? parseInt(warnMatch[1], 10) : null;
                const isError = !scriptSucceeded || (errorCount !== null && errorCount > 0);
                let message: string;
                if (errorCount !== null) {
                    message = isError
                        ? `set_orchestrator FAILED for ${absPath}: ${errorCount} error(s).`
                        : `Orchestrator '${pouName ?? 'PLC_PRG'}' set with ${callCount ?? '?'} call(s): builds with ${errorCount} error(s), ${warningCount ?? 0} warning(s).`;
                } else {
                    message = scriptSucceeded
                        ? `Orchestrator set (build skipped/unparsed). Output:\n${result.output}`
                        : `set_orchestrator failed for ${absPath}. Output:\n${result.output}`;
                }
                return { content: [{ type: "text", text: message }], isError: isError };
            } catch (e:any) {
                console.error(`Error set_orchestrator ${absPath}: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );
    server.tool(
        "cfc_build_device", // Tool Name
        "Synthesizes a new device control program (CFC/FBD) FROM A SPEC (no template file): one FB box of the given catalog type, bound to a global instance, with the given input pins (each wired to an operand/variable/literal) and output pins. Auto-declares the instance in the GVL, imports into CFCs, builds and verifies. Use when no template export exists or for arbitrary pin configurations. (Single-box device pattern; for connected multi-box logic use a template/native graft.)", // Description
        { // Input Schema
            projectFilePath: z.string().describe("Path to the .project file."),
            name: z.string().describe("Name of the new device program, e.g. 'NS_N1'."),
            boxType: z.string().describe("Catalog FB type for the box, e.g. 'TYP_IDF1', 'TYP_AIN', 'TYP_2PT'."),
            instance: z.string().describe("Global FB instance name to call/bind, e.g. 'N1'."),
            inputs: z.array(z.object({
                pin: z.string().describe("Input pin name, e.g. 'Lock1', 'X_W'."),
                type: z.string().describe("Pin data type, e.g. 'BOOL', 'INT'."),
                operand: z.string().describe("Operand wired to the pin: a variable ('L104.SL'), literal ('80'/'FALSE'), or '' to leave open.")
            })).describe("Input pins to wire. Unconnected pins may be omitted."),
            outputs: z.array(z.object({
                pin: z.string().describe("Output pin name, e.g. 'OUT1'."),
                type: z.string().describe("Pin data type, e.g. 'BOOL'.")
            })).optional().describe("Output pins to expose. Optional."),
            instanceType: z.string().optional().describe("FB type for the GVL declaration. Defaults to boxType."),
            targetFolder: z.string().optional().describe("Folder to import into. Defaults to 'CFCs'."),
            gvlName: z.string().optional().describe("GVL to declare the instance in. Defaults to 'GVL'."),
            declareInGvl: z.boolean().optional().describe("Declare the instance in the GVL if missing. Defaults to true."),
            build: z.boolean().optional().describe("Build and verify afterwards. Defaults to true.")
        },
        async (args) => { // Handler
            const { projectFilePath, name, boxType, instance, inputs, outputs, instanceType, targetFolder, gvlName, declareInGvl, build } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            const doBuild = (build === false) ? "False" : "True";
            const doDeclare = (declareInGvl === false) ? "False" : "True";
            console.error(`Tool call: cfc_build_device: ${name} (${boxType}/${instance}) -> ${absPath}`);
            try {
                const escProj = absPath.replace(/\\/g, '\\\\');
                let script = CFC_BUILD_DEVICE_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProj);
                script = script.replace("{NAME}", name);
                script = script.replace("{BOX_TYPE}", boxType);
                script = script.replace("{INSTANCE}", instance);
                script = script.replace("{INSTANCE_TYPE}", instanceType ?? "");
                script = script.replace("{INPUTS_JSON}", JSON.stringify(inputs ?? []));
                script = script.replace("{OUTPUTS_JSON}", JSON.stringify(outputs ?? []));
                script = script.replace("{TARGET_FOLDER}", targetFolder ?? "CFCs");
                script = script.replace("{GVL_NAME}", gvlName ?? "GVL");
                script = script.replace("{DECLARE_GVL}", doDeclare);
                script = script.replace("{DO_BUILD}", doBuild);
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                const scriptSucceeded = result.success && result.output.includes("SCRIPT_SUCCESS");
                const addedMatch = result.output.match(/Added:\s*(\d+)/);
                const errMatch = result.output.match(/Errors:\s*(\d+)/);
                const warnMatch = result.output.match(/Warnings:\s*(\d+)/);
                const verifyMatch = result.output.match(/Verify:\s*box=(\w+)\s+instance=(\w+)/);
                const addedCount: number | null = addedMatch ? parseInt(addedMatch[1], 10) : null;
                const errorCount: number | null = errMatch ? parseInt(errMatch[1], 10) : null;
                const warningCount: number | null = warnMatch ? parseInt(warnMatch[1], 10) : null;
                const isError = !scriptSucceeded || (errorCount !== null && errorCount > 0) || (addedCount !== null && addedCount < 1);
                let message: string;
                if (addedCount !== null) {
                    const verify = verifyMatch ? ` Verify: box=${verifyMatch[1]}, instance=${verifyMatch[2]}.` : "";
                    message = isError
                        ? `cfc_build_device FAILED for '${name}': ${errorCount ?? '?'} error(s), added=${addedCount}.${verify}`
                        : `Device '${name}' (${boxType}/${instance}) synthesized as CFC: ${errorCount ?? 0} error(s), ${warningCount ?? 0} warning(s).${verify} Project saved.`;
                } else {
                    message = scriptSucceeded
                        ? `cfc_build_device completed but results could not be parsed. Output:\n${result.output}`
                        : `cfc_build_device failed. Output:\n${result.output}`;
                }
                return { content: [{ type: "text", text: message }], isError: isError };
            } catch (e:any) {
                console.error(`Error cfc_build_device: ${e}`);
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    // ===================== Stufe B: Geraetebaum-Werkzeuge (list/import/add device) =====================
    const LIST_DEVICES_SCRIPT_TEMPLATE = `
import sys, scriptengine as script_engine, traceback
try:
    name_f = "{NAME_FILTER}".lower()
    vendor_f = "{VENDOR_FILTER}".lower()
    print("--- DEVICE LIST START ---")
    n = 0
    for dev in script_engine.device_repository.get_all_devices():
        di = dev.device_info
        nm = getattr(di, "name", None) or getattr(di, "description", "") or ""
        vd = getattr(di, "vendor", "") or ""
        low = (nm + " " + vd).lower()
        if name_f and name_f not in low: continue
        if vendor_f and vendor_f not in low: continue
        d = dev.device_id
        print("DEV|%s|%s|%s|%s|%s" % (nm, vd, d.type, d.id, d.version))
        n += 1
    print("--- DEVICE LIST END ---")
    print("Count: %d" % n)
    print("SCRIPT_SUCCESS")
except Exception as ex:
    print("SCRIPT_ERROR: %s" % ex); traceback.print_exc(); sys.exit(1)
`;

    const IMPORT_DEVICE_SCRIPT_TEMPLATE = `
import sys, os, scriptengine as script_engine, traceback
from System import Guid
try:
    p = "{GSDML_PATH}"
    if not os.path.exists(p):
        print("SCRIPT_ERROR: file not found: %s" % p); sys.exit(1)
    conv = Guid("{CONVERTER_GUID}")
    src = script_engine.device_repository.sources[0]
    before = len(list(script_engine.device_repository.get_all_devices()))
    devid = script_engine.device_repository.import_device(p, src, conv, True)
    after = len(list(script_engine.device_repository.get_all_devices()))
    print("Imported: %s" % (devid,))
    print("Added: %d" % (after - before))
    print("SCRIPT_SUCCESS")
except Exception as ex:
    print("SCRIPT_ERROR: %s" % ex); traceback.print_exc(); sys.exit(1)
`;

    const ADD_DEVICE_SCRIPT_TEMPLATE = `
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
try:
    ensure_project_open("{PROJECT_FILE_PATH}")
    proj = script_engine.projects.primary
    if proj is None:
        print("SCRIPT_ERROR: no primary project after open"); sys.exit(1)
    want_name = "{DEVICE_NAME}".lower()
    want_ver = "{DEVICE_VERSION}"
    chosen = None
    for dev in script_engine.device_repository.get_all_devices():
        di = dev.device_info
        nm = (getattr(di, "name", None) or getattr(di, "description", "") or "")
        if want_name in nm.lower() and (not want_ver or want_ver in str(dev.device_id.version)):
            chosen = dev; break
    if chosen is None:
        print("SCRIPT_ERROR: device not found in repository: %s" % want_name); sys.exit(1)
    parent_name = "{PARENT_NAME}"
    if parent_name:
        matches = proj.find(parent_name, True)
        if not matches:
            print("SCRIPT_ERROR: parent node not found: %s" % parent_name); sys.exit(1)
        parent = matches[0]
    else:
        parent = proj
    inst = "{INSTANCE_NAME}"
    parent.add(inst, chosen.device_id)
    node = None
    for k in reversed(list(parent.get_children(False))):
        try:
            if k.get_name() == inst:
                node = k; break
        except Exception:
            pass
    proj.save()
    print("AddedDevice: %s under %s" % (inst, parent_name or "<project>"))
    print("NodeFound: %s" % ("yes" if node else "no"))
    print("SCRIPT_SUCCESS")
except Exception as ex:
    print("SCRIPT_ERROR: %s" % ex); traceback.print_exc(); sys.exit(1)
`;

    server.tool(
        "list_devices",
        "Lists devices in the CODESYS device repository, optionally filtered by name and/or vendor substring. Returns name, vendor and device identification (type, id, version) needed for add_device.",
        {
            nameFilter: z.string().optional().describe("Case-insensitive substring for the device name/description (e.g. 'ET200S', 'IM151-3 PN HF', '8741')."),
            vendorFilter: z.string().optional().describe("Case-insensitive substring for the vendor (e.g. 'Siemens', 'buerkert').")
        },
        async (args) => {
            const { nameFilter, vendorFilter } = args;
            try {
                let script = LIST_DEVICES_SCRIPT_TEMPLATE.replace("{NAME_FILTER}", (nameFilter ?? "").replace(/"/g, ""));
                script = script.replace("{VENDOR_FILTER}", (vendorFilter ?? "").replace(/"/g, ""));
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                const ok = result.success && result.output.includes("SCRIPT_SUCCESS");
                const s = result.output.indexOf("--- DEVICE LIST START ---");
                const e = result.output.indexOf("--- DEVICE LIST END ---");
                const list = (s !== -1 && e !== -1) ? result.output.substring(s, e).split(/[\r\n]+/).filter(l => l.startsWith("DEV|")).join("\n") : "";
                const message = ok ? (list || "No matching devices found.") : `list_devices failed. Output:\n${result.output}`;
                return { content: [{ type: "text", text: message }], isError: !ok };
            } catch (e:any) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "import_device",
        "Imports a device description (GSDML/GSD/EDS) into the CODESYS device repository so it can be placed in the device tree. GSDML files must be real XML with a .xml extension. Uses the universal converter factory.",
        {
            filePath: z.string().describe("Absolute path to the device description file (e.g. 'C:/.../GSDML-...-ET200S.xml'). GSDML must be .xml."),
            converterGuid: z.string().optional().describe("Converter factory GUID. Defaults to C633F245-876F-45E8-AAB4-3FBD994C08B8 (auto-detects GSDML/GSD/EDS).")
        },
        async (args) => {
            const { filePath, converterGuid } = args;
            let absPath = path.normalize(path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_DIR, filePath));
            try {
                if (!(await fileExists(absPath))) {
                    return { content: [{ type: "text", text: `Error: device description file not found: ${absPath}` }], isError: true };
                }
                const guid = (converterGuid ?? "C633F245-876F-45E8-AAB4-3FBD994C08B8").replace(/[{}]/g, "");
                let script = IMPORT_DEVICE_SCRIPT_TEMPLATE.replace("{GSDML_PATH}", absPath.replace(/\\/g, "\\\\"));
                script = script.replace("{CONVERTER_GUID}", "{" + guid + "}");
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                const ok = result.success && result.output.includes("SCRIPT_SUCCESS");
                const added = (result.output.match(/Added:\s*(\d+)/) || [])[1];
                const imported = (result.output.match(/Imported:\s*(.+)/) || [])[1];
                const message = ok
                    ? `Device description imported into repository. New entries: ${added ?? "?"}.${imported ? " DeviceID: " + imported.trim() : ""}`
                    : `import_device failed for ${absPath}. Output:\n${result.output}`;
                return { content: [{ type: "text", text: message }], isError: !ok };
            } catch (e:any) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "add_device",
        "Adds a device from the repository into the project tree, nested under a parent node identified by its object name. Use list_devices first. The parent must accept the child (e.g. a ProfiNet IO device goes under a PN-Controller, not directly under Ethernet).",
        {
            projectFilePath: z.string().describe("Path to the .project file to modify."),
            deviceName: z.string().describe("Substring of the repository device name to add (e.g. 'IM151-3 PN HF', 'Type 8741 PROFINET', 'PN-Controller', 'Ethernet')."),
            deviceVersion: z.string().optional().describe("Optional version substring to disambiguate (e.g. 'V07.00', '3.5.22')."),
            instanceName: z.string().describe("Name for the new node in the tree (no spaces, e.g. 'RIO_ET200S', 'FlowSensor')."),
            parentName: z.string().optional().describe("Object name of the parent node to add under (e.g. 'PN_Controller', 'Ethernet_1'). Omit to add at the top level (PLC device).")
        },
        async (args) => {
            const { projectFilePath, deviceName, deviceVersion, instanceName, parentName } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            try {
                const escProj = absPath.replace(/\\/g, "\\\\");
                let script = ADD_DEVICE_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProj);
                script = script.replace("{DEVICE_NAME}", deviceName.replace(/"/g, ""));
                script = script.replace("{DEVICE_VERSION}", (deviceVersion ?? "").replace(/"/g, ""));
                script = script.replace("{PARENT_NAME}", (parentName ?? "").replace(/"/g, ""));
                script = script.replace("{INSTANCE_NAME}", instanceName.replace(/"/g, ""));
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                const ok = result.success && result.output.includes("SCRIPT_SUCCESS");
                const added = (result.output.match(/AddedDevice:\s*(.+)/) || [])[1];
                const message = ok
                    ? `Device added: ${added ? added.trim() : instanceName}. Project saved.`
                    : `add_device failed. Output:\n${result.output}`;
                return { content: [{ type: "text", text: message }], isError: !ok };
            } catch (e:any) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    const SET_DEVICE_PARAMETER_SCRIPT_TEMPLATE = `
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
try:
    ensure_project_open("{PROJECT_FILE_PATH}")
    proj = script_engine.projects.primary
    if proj is None:
        print("SCRIPT_ERROR: no primary project after open"); sys.exit(1)
    dev_name = "{DEVICE_NAME}"
    matches = proj.find(dev_name, True)
    if not matches:
        print("SCRIPT_ERROR: device node not found: %s" % dev_name); sys.exit(1)
    node = matches[0]
    if not hasattr(node, "device_parameters"):
        print("SCRIPT_ERROR: node has no device parameters: %s" % dev_name); sys.exit(1)
    params = node.device_parameters()
    match = "{PARAM_MATCH}"
    value = "{VALUE}"
    if not match:
        print("--- PARAM LIST START ---")
        for p in params:
            try:
                pid = getattr(p, "id", "")
                nm = getattr(p, "name", "") or ""
                try:
                    val = p.value
                except Exception:
                    val = "<compound>"
                ct = getattr(p, "channel_type", "")
                print("PARAM|%s|%s|%s|%s" % (pid, nm, ct, val))
            except Exception as e2:
                print("PARAM|?|<err %s>|" % e2)
        print("--- PARAM LIST END ---")
        print("SCRIPT_SUCCESS")
    else:
        try:
            mid = int(match)
        except Exception:
            mid = None
        target = None
        for p in params:
            if mid is not None:
                if getattr(p, "id", None) == mid:
                    target = p; break
            else:
                if match.lower() in (getattr(p, "name", "") or "").lower():
                    target = p; break
        if target is None:
            print("SCRIPT_ERROR: parameter not found: %s" % match); sys.exit(1)
        old = ""
        try:
            old = target.value
        except Exception:
            pass
        target.value = value
        proj.save()
        print("ParamSet: id=%s name=%s old=%s new=%s" % (getattr(target, "id", ""), getattr(target, "name", ""), old, value))
        print("SCRIPT_SUCCESS")
except Exception as ex:
    print("SCRIPT_ERROR: %s" % ex); traceback.print_exc(); sys.exit(1)
`;

    const SET_IO_MAPPING_SCRIPT_TEMPLATE = `
${ENSURE_PROJECT_OPEN_PYTHON_SNIPPET}
try:
    ensure_project_open("{PROJECT_FILE_PATH}")
    proj = script_engine.projects.primary
    if proj is None:
        print("SCRIPT_ERROR: no primary project after open"); sys.exit(1)
    dev_name = "{DEVICE_NAME}"
    matches = proj.find(dev_name, True)
    if not matches:
        print("SCRIPT_ERROR: device node not found: %s" % dev_name); sys.exit(1)
    node = matches[0]
    if not hasattr(node, "device_parameters"):
        print("SCRIPT_ERROR: node has no device parameters: %s" % dev_name); sys.exit(1)
    params = node.device_parameters()
    match = "{CHANNEL_MATCH}"
    variable = "{VARIABLE}"
    address = "{ADDRESS}"
    def cur_addr(m):
        try:
            return m.manual_iec_address or ""
        except Exception:
            return ""
    def cur_var(m):
        try:
            return m.variable or ""
        except Exception:
            return ""
    if not match:
        print("--- IO LIST START ---")
        for p in params:
            try:
                if not getattr(p, "is_mappable_io", False):
                    continue
                m = p.io_mapping
                if m is None:
                    continue
                nm = getattr(p, "name", "") or ""
                ct = getattr(p, "channel_type", "")
                print("IO|%s|%s|%s|%s|%s" % (getattr(p, "id", ""), nm, ct, cur_addr(m), cur_var(m)))
            except Exception as e2:
                print("IO|?|<err %s>|||" % e2)
        print("--- IO LIST END ---")
        print("SCRIPT_SUCCESS")
    else:
        target = None
        for p in params:
            try:
                if not getattr(p, "is_mappable_io", False):
                    continue
                m = p.io_mapping
                if m is None:
                    continue
                nm = (getattr(p, "name", "") or "").lower()
                if match.lower() in nm or match == cur_addr(m):
                    target = (p, m); break
            except Exception:
                pass
        if target is None:
            print("SCRIPT_ERROR: mappable channel not found: %s" % match); sys.exit(1)
        p, m = target
        if variable:
            m.variable = variable
        if address:
            m.manual_iec_address = address
        proj.save()
        print("IoMapped: name=%s var=%s addr=%s" % (getattr(p, "name", ""), variable, address or cur_addr(m)))
        print("SCRIPT_SUCCESS")
except Exception as ex:
    print("SCRIPT_ERROR: %s" % ex); traceback.print_exc(); sys.exit(1)
`;

    server.tool(
        "set_device_parameter",
        "Reads or sets a parameter on a device node. Omit 'parameter' to LIST all parameters (id | name | channelType | value) for discovery; provide 'parameter' (id number or name substring) plus 'value' to set one. Typical use: assign the network adapter of an 'Ethernet' node, or a PROFINET IP.",
        {
            projectFilePath: z.string().describe("Path to the .project file to read/modify."),
            deviceName: z.string().describe("Object name (substring) of the device node, e.g. 'Ethernet', 'PN_Controller', 'ET200S'."),
            parameter: z.string().optional().describe("Parameter id (number as string, exact) or a name substring. Omit to list all parameters."),
            value: z.string().optional().describe("New value to assign. Required together with 'parameter'.")
        },
        async (args) => {
            const { projectFilePath, deviceName, parameter, value } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            try {
                const escProj = absPath.replace(/\\/g, "\\\\");
                let script = SET_DEVICE_PARAMETER_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProj);
                script = script.replace("{DEVICE_NAME}", deviceName.replace(/"/g, ""));
                script = script.replace("{PARAM_MATCH}", (parameter ?? "").replace(/"/g, ""));
                script = script.replace("{VALUE}", (value ?? "").replace(/"/g, ""));
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                const ok = result.success && result.output.includes("SCRIPT_SUCCESS");
                let text;
                if (!parameter) {
                    const s = result.output.indexOf("--- PARAM LIST START ---");
                    const e = result.output.indexOf("--- PARAM LIST END ---");
                    const list = (s !== -1 && e !== -1) ? result.output.substring(s, e).split(/[\r\n]+/).filter(l => l.startsWith("PARAM|")).join("\n") : "";
                    text = ok ? (list || "No parameters found.") : `set_device_parameter (list) failed. Output:\n${result.output}`;
                } else {
                    const setLine = (result.output.match(/ParamSet:\s*(.+)/) || [])[1];
                    text = ok ? `Parameter set. ${setLine ? setLine.trim() : ""}` : `set_device_parameter failed. Output:\n${result.output}`;
                }
                return { content: [{ type: "text", text }], isError: !ok };
            } catch (e:any) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "set_io_mapping",
        "Reads or sets the I/O mapping of a device's channels. Omit 'channel' to LIST mappable channels (id | name | channelType | address | variable); provide 'channel' (name substring or current IEC address) plus 'variable' and/or 'address' to map one channel. An unqualified variable name creates a new variable; a qualified name maps to an existing one.",
        {
            projectFilePath: z.string().describe("Path to the .project file to read/modify."),
            deviceName: z.string().describe("Object name (substring) of the module/device carrying the channels, e.g. '2DI', '2DO', 'FlowSensor'."),
            channel: z.string().optional().describe("Channel selector: a name substring or the current IEC address (e.g. '%IX46.0'). Omit to list all mappable channels."),
            variable: z.string().optional().describe("Symbolic variable name to assign (e.g. 'LSH'). Unqualified => creates a variable."),
            address: z.string().optional().describe("Manual IEC address to assign (e.g. '%QX4.0'). Omit to keep the current/automatic address.")
        },
        async (args) => {
            const { projectFilePath, deviceName, channel, variable, address } = args;
            let absPath = path.normalize(path.isAbsolute(projectFilePath) ? projectFilePath : path.join(WORKSPACE_DIR, projectFilePath));
            try {
                const escProj = absPath.replace(/\\/g, "\\\\");
                let script = SET_IO_MAPPING_SCRIPT_TEMPLATE.replace("{PROJECT_FILE_PATH}", escProj);
                script = script.replace("{DEVICE_NAME}", deviceName.replace(/"/g, ""));
                script = script.replace("{CHANNEL_MATCH}", (channel ?? "").replace(/"/g, ""));
                script = script.replace("{VARIABLE}", (variable ?? "").replace(/"/g, ""));
                script = script.replace("{ADDRESS}", (address ?? "").replace(/"/g, ""));
                const result = await executeCodesysScript(script, codesysExePath, codesysProfileName);
                const ok = result.success && result.output.includes("SCRIPT_SUCCESS");
                let text;
                if (!channel) {
                    const s = result.output.indexOf("--- IO LIST START ---");
                    const e = result.output.indexOf("--- IO LIST END ---");
                    const list = (s !== -1 && e !== -1) ? result.output.substring(s, e).split(/[\r\n]+/).filter(l => l.startsWith("IO|")).join("\n") : "";
                    text = ok ? (list || "No mappable channels found.") : `set_io_mapping (list) failed. Output:\n${result.output}`;
                } else {
                    const setLine = (result.output.match(/IoMapped:\s*(.+)/) || [])[1];
                    text = ok ? `Channel mapped. ${setLine ? setLine.trim() : ""}` : `set_io_mapping failed. Output:\n${result.output}`;
                }
                return { content: [{ type: "text", text }], isError: !ok };
            } catch (e:any) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    // --- End Tools ---

    console.error("SERVER.TS: Resources and Tools defined.");
    // --- End MCP Resources / Tools Definitions ---


    // --- Server Connection ---
    console.error("SERVER.TS: startServer() internal logic executing.");
    try {
        const transport = new StdioServerTransport();
        console.error("SERVER.TS: Connecting MCP server via stdio...");
        // No need to await connect here if startMcpServer is called by bin.ts which awaits it
        // await server.connect(transport);
        server.connect(transport); // Connect but don't await here, let bin.ts handle waiting
        console.error("SERVER.TS: MCP Server connection initiated via stdio.");
        // console.error("SERVER.TS: server.connect() promise resolved successfully."); // This log might be premature now
    } catch (error) {
        console.error("FATAL: Failed to initiate MCP server connection:", error);
        // Re-throw error so bin.ts can catch it
        throw error;
        // process.exit(1);
    }
    // --- End Server Connection ---

} // --- End of startMcpServer function ---


// --- Graceful Shutdown / Unhandled Rejection ---
// These should remain at the top level, outside startMcpServer
process.on('SIGINT', () => {
    console.error('\nSERVER.TS: SIGINT received, shutting down...');
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.error('\nSERVER.TS: SIGTERM received, shutting down...');
    process.exit(0);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('SERVER.TS: Unhandled Rejection at:', promise, 'reason:', reason);
});
// --- End Graceful Shutdown / Unhandled Rejection ---

console.error(">>> SERVER.TS Module Parsed <<<"); // Log end of script parsing