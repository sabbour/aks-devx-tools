import {longRunning} from '../../utils/host';
import {Context} from './model/context';
import * as vscode from 'vscode';
import {ensureDraftBinary, runDraftCommand} from './helper/runDraftHelper';
import {
   DraftLanguage,
   draftLanguages,
   getDraftLanguages
} from './helper/languages';
import {
   AzureWizard,
   AzureWizardExecuteStep,
   AzureWizardPromptStep,
   IActionContext
} from '@microsoft/vscode-azext-utils';
import * as path from 'path';
import * as fs from 'fs';
import {
   buildCreateCommand,
   buildCreateConfig
} from './helper/draftCommandBuilder';
import {State, StateApi} from '../../utils/state';
import {ignoreFocusOut} from './helper/commonPrompts';
import {CompletedSteps} from './model/guidedExperience';
import {ValidatePort} from '../../utils/validation';
import {getAsyncResult} from '../../utils/errorable';
import {getAsyncOptions} from '../../utils/quickPick';

const title = 'Draft a Dockerfile from source code';

interface PromptContext {
   sourceCodeFolder: vscode.Uri;
   language: DraftLanguage;
   version: string;
   port: string;
}
type WizardContext = IActionContext & Partial<PromptContext>;
type IPromptStep = AzureWizardPromptStep<WizardContext>;
type IExecuteStep = AzureWizardExecuteStep<WizardContext>;

export async function runDraftDockerfile(
   {actionContext, extensionContext}: Context,
   sourceCodeFolder: vscode.Uri | undefined,
   completedSteps: CompletedSteps
) {
   const state: StateApi = State.construct(extensionContext);

   // Ensure Draft Binary
   const downloadResult = await longRunning(`Downloading Draft.`, () =>
      getAsyncResult(ensureDraftBinary())
   );
   if (!downloadResult) {
      vscode.window.showErrorMessage('Failed to download Draft');
      return undefined;
   }

   const workspaceFolders = vscode.workspace.workspaceFolders;
   if (!sourceCodeFolder && workspaceFolders && workspaceFolders.length !== 0) {
      sourceCodeFolder = workspaceFolders[0].uri;
   }
   const wizardContext: WizardContext = {
      ...actionContext,
      sourceCodeFolder: sourceCodeFolder
   };
   const promptSteps: IPromptStep[] = [
      new PromptSourceCodeFolder(),
      new PromptDockerfileOverride(),
      new PromptLanguage(),
      new PromptVersion(),
      new PromptPort()
   ];
   const executeSteps: IExecuteStep[] = [
      new ExecuteDraft(),
      new ExecuteOpenDockerfiles(),
      new ExecuteSaveState(state),
      new ExecutePromptAcr(completedSteps)
   ];
   const wizard = new AzureWizard(wizardContext, {
      title,
      promptSteps,
      executeSteps
   });
   await wizard.prompt();
   await wizard.execute();
}

class PromptSourceCodeFolder extends AzureWizardPromptStep<WizardContext> {
   public async prompt(wizardContext: WizardContext): Promise<void> {
      const sourceCodeFolder = (
         await wizardContext.ui.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            stepName: 'Source Code Folder',
            openLabel: 'Choose Source Code Folder',
            title: 'Choose Source Code Folder',
            defaultUri: wizardContext.sourceCodeFolder
         })
      )[0];

      if (!vscode.workspace.getWorkspaceFolder(sourceCodeFolder)) {
         throw Error(
            'Chosen Source Code Folder is not in current workspace. Please choose a folder in the workspace'
         );
      }

      wizardContext.sourceCodeFolder = sourceCodeFolder;
   }

   public shouldPrompt(wizardContext: WizardContext): boolean {
      return true;
   }
}

class PromptLanguage extends AzureWizardPromptStep<WizardContext> {
   public async prompt(wizardContext: WizardContext): Promise<void> {
      const languageToItem = (lang: DraftLanguage) => ({label: lang.name});
      const draftLanguages = getAsyncResult(getDraftLanguages());
      const languagePick = await wizardContext.ui.showQuickPick(
         getAsyncOptions(draftLanguages, languageToItem),
         {
            ignoreFocusOut,
            stepName: 'Programming Language',
            placeHolder: 'Select the programming language'
         }
      );
      const language = (await draftLanguages).find(
         (lang) => languageToItem(lang).label === languagePick.label
      );
      if (language === undefined) {
         throw Error('Language was not recognized'); // this should never happen
      }

      wizardContext.language = language;
   }

   public shouldPrompt(wizardContext: WizardContext): boolean {
      return true;
   }
}

class PromptVersion extends AzureWizardPromptStep<WizardContext> {
   public async prompt(wizardContext: WizardContext): Promise<void> {
      const language = wizardContext.language;
      if (language === undefined) {
         throw Error('Language is undefined');
      }

      const versionOptions: vscode.QuickPickItem[] = language.versions.map(
         (version) => ({label: version})
      );
      const versionPick = await wizardContext.ui.showQuickPick(versionOptions, {
         ignoreFocusOut,
         stepName: 'Version',
         placeHolder: `Select ${language.name} version`
      });
      wizardContext.version = versionPick.label;
   }

   public shouldPrompt(wizardContext: WizardContext): boolean {
      return true;
   }
}

class PromptDockerfileOverride extends AzureWizardPromptStep<WizardContext> {
   public async prompt(wizardContext: WizardContext): Promise<void> {
      const dockerfilePath = getDockerfilePath(wizardContext);
      await wizardContext.ui.showWarningMessage(
         `Override file ${dockerfilePath}`,
         {modal: true},
         {title: 'Ok'}
      );
   }
   public shouldPrompt(wizardContext: WizardContext): boolean {
      const dockerfilePath = getDockerfilePath(wizardContext);
      if (fs.existsSync(dockerfilePath)) {
         return true;
      }

      return false;
   }
}

export class PromptPort extends AzureWizardPromptStep<
   IActionContext & Partial<{port: string}>
> {
   public async prompt(
      wizardContext: IActionContext & Partial<{port: string}>
   ): Promise<void> {
      wizardContext.port = await wizardContext.ui.showInputBox({
         ignoreFocusOut,
         prompt: 'Port (e.g. 8080)',
         stepName: 'Port',
         validateInput: ValidatePort,
         value: wizardContext.port
      });
   }

   public shouldPrompt(
      wizardContext: IActionContext & Partial<{port: string}>
   ): boolean {
      return true;
   }
}

class ExecuteDraft extends AzureWizardExecuteStep<WizardContext> {
   public priority: number = 1;

   public async execute(
      wizardContext: WizardContext,
      progress: vscode.Progress<{
         message?: string | undefined;
         increment?: number | undefined;
      }>
   ): Promise<void> {
      const {language, port, sourceCodeFolder, version} = wizardContext;
      if (language === undefined) {
         throw Error('Language is undefined');
      }
      if (port === undefined) {
         throw Error('Port is undefined');
      }
      if (sourceCodeFolder === undefined) {
         throw Error('Source code folder is undefined');
      }
      if (version === undefined) {
         throw Error('Version is undefined');
      }

      const configPath = buildCreateConfig(
         language.id,
         port,
         '',
         '',
         version,
         '',
         ''
      );
      const command = buildCreateCommand(
         sourceCodeFolder.fsPath,
         'dockerfile',
         configPath
      );

      const [success, err] = await runDraftCommand(command);
      const isSuccess = err?.length === 0 && success?.length !== 0;
      if (!isSuccess) {
         throw Error(`Draft command failed: ${err}`);
      }
   }

   public shouldExecute(wizardContext: WizardContext): boolean {
      return true;
   }
}

class ExecuteOpenDockerfiles extends AzureWizardExecuteStep<WizardContext> {
   public priority: number = 2;
   public async execute(
      wizardContext: WizardContext,
      progress: vscode.Progress<{
         message?: string | undefined;
         increment?: number | undefined;
      }>
   ): Promise<void> {
      const dockerignorePath = getDockerignorePath(wizardContext);
      const dockerPath = getDockerfilePath(wizardContext);

      for (const filePath of [dockerignorePath, dockerPath]) {
         const vscodePath = vscode.Uri.file(filePath);
         await vscode.workspace
            .openTextDocument(vscodePath)
            .then((doc) =>
               vscode.window.showTextDocument(doc, {preview: false})
            );
      }
   }

   public shouldExecute(wizardContext: WizardContext): boolean {
      return true;
   }
}

class ExecuteSaveState extends AzureWizardExecuteStep<WizardContext> {
   public priority: number = 3;

   constructor(private state: StateApi) {
      super();
   }

   public async execute(
      wizardContext: WizardContext,
      progress: vscode.Progress<{
         message?: string | undefined;
         increment?: number | undefined;
      }>
   ): Promise<void> {
      const {port} = wizardContext;
      if (port !== undefined) {
         this.state.setPort(port);
      }

      const dockerfilePath = getDockerfilePath(wizardContext);
      this.state.setDockerfile(dockerfilePath);
   }

   public shouldExecute(wizardContext: WizardContext): boolean {
      return true;
   }
}

class ExecutePromptAcr extends AzureWizardExecuteStep<WizardContext> {
   public priority: number = 4;

   constructor(private completedSteps: CompletedSteps) {
      super();
   }

   public async execute(
      wizardContext: WizardContext,
      progress: vscode.Progress<{
         message?: string | undefined;
         increment?: number | undefined;
      }>
   ): Promise<void> {
      const buildAcrButton = 'Build';
      await vscode.window
         .showInformationMessage(
            'The Dockerfile was created. Next, build the image on Azure Container Registry.',
            buildAcrButton
         )
         .then((input) => {
            if (input === buildAcrButton) {
               this.completedSteps.draftDockerfile = true;
               vscode.commands.executeCommand(
                  'aks-draft-extension.runBuildAcrImage',
                  this.completedSteps
               );
            }
         });
   }
   public shouldExecute(wizardContext: WizardContext): boolean {
      return true;
   }
}

function getDockerfilePath(wizardContext: WizardContext): string {
   const sourceCodeFolderPath = wizardContext.sourceCodeFolder?.path;
   if (sourceCodeFolderPath === undefined) {
      throw Error('Source code folder is undefined');
   }

   return path.join(sourceCodeFolderPath, 'Dockerfile');
}

function getDockerignorePath(wizardContext: WizardContext): string {
   const sourceCodeFolderPath = wizardContext.sourceCodeFolder?.path;
   if (sourceCodeFolderPath === undefined) {
      throw Error('Source code folder is undefined');
   }

   return path.join(sourceCodeFolderPath, '.dockerignore');
}
