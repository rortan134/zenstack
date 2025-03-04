import { ZModelGeneratedModule, ZModelGeneratedSharedModule } from '@zenstackhq/language/module';
import {
    createDefaultModule,
    DefaultConfigurationProvider,
    DefaultDocumentBuilder,
    DefaultIndexManager,
    DefaultLangiumDocumentFactory,
    DefaultLangiumDocuments,
    DefaultLanguageServer,
    DefaultServiceRegistry,
    DefaultSharedModuleContext,
    inject,
    LangiumDefaultSharedServices,
    LangiumServices,
    LangiumSharedServices,
    Module,
    MutexLock,
    PartialLangiumServices,
} from 'langium';
import { TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ZModelValidationRegistry, ZModelValidator } from './validator/zmodel-validator';
import { ZModelCodeActionProvider } from './zmodel-code-action';
import { ZModelFormatter } from './zmodel-formatter';
import { ZModelLinker } from './zmodel-linker';
import { ZModelScopeComputation, ZModelScopeProvider } from './zmodel-scope';
import ZModelWorkspaceManager from './zmodel-workspace-manager';
import { ZModelDefinitionProvider } from './zmodel-definition';
import { ZModelSemanticTokenProvider } from './zmodel-semantic';

/**
 * Declaration of custom services - add your own service classes here.
 */
export type ZModelAddedServices = {
    validation: {
        ZModelValidator: ZModelValidator;
    };
};

/**
 * Union of Langium default services and your custom services - use this as constructor parameter
 * of custom service classes.
 */
export type ZModelServices = LangiumServices & ZModelAddedServices;

/**
 * Dependency injection module that overrides Langium default services and contributes the
 * declared custom services. The Langium defaults can be partially specified to override only
 * selected services, while the custom services must be fully specified.
 */
export const ZModelModule: Module<ZModelServices, PartialLangiumServices & ZModelAddedServices> = {
    references: {
        ScopeComputation: (services) => new ZModelScopeComputation(services),
        Linker: (services) => new ZModelLinker(services),
        ScopeProvider: (services) => new ZModelScopeProvider(services),
    },
    validation: {
        ValidationRegistry: (services) => new ZModelValidationRegistry(services),
        ZModelValidator: (services) => new ZModelValidator(services),
    },
    lsp: {
        Formatter: () => new ZModelFormatter(),
        CodeActionProvider: (services) => new ZModelCodeActionProvider(services),
        DefinitionProvider: (services) => new ZModelDefinitionProvider(services),
        SemanticTokenProvider: (services) => new ZModelSemanticTokenProvider(services),
    },
};

// this duplicates createDefaultSharedModule except that a custom WorkspaceManager is used
export function createSharedModule(
    context: DefaultSharedModuleContext
): Module<LangiumSharedServices, LangiumDefaultSharedServices> {
    return {
        ServiceRegistry: () => new DefaultServiceRegistry(),
        lsp: {
            Connection: () => context.connection,
            LanguageServer: (services) => new DefaultLanguageServer(services),
        },
        workspace: {
            LangiumDocuments: (services) => new DefaultLangiumDocuments(services),
            LangiumDocumentFactory: (services) => new DefaultLangiumDocumentFactory(services),
            DocumentBuilder: (services) => new DefaultDocumentBuilder(services),
            TextDocuments: () => new TextDocuments(TextDocument),
            IndexManager: (services) => new DefaultIndexManager(services),
            WorkspaceManager: (services) => new ZModelWorkspaceManager(services),
            FileSystemProvider: (services) => context.fileSystemProvider(services),
            MutexLock: () => new MutexLock(),
            ConfigurationProvider: (services) => new DefaultConfigurationProvider(services),
        },
    };
}

/**
 * Create the full set of services required by Langium.
 *
 * First inject the shared services by merging two modules:
 *  - Langium default shared services
 *  - Services generated by langium-cli
 *
 * Then inject the language-specific services by merging three modules:
 *  - Langium default language-specific services
 *  - Services generated by langium-cli
 *  - Services specified in this file
 *
 * @param context Optional module context with the LSP connection
 * @returns An object wrapping the shared services and the language-specific services
 */
export function createZModelServices(context: DefaultSharedModuleContext): {
    shared: LangiumSharedServices;
    ZModel: ZModelServices;
} {
    const shared = inject(createSharedModule(context), ZModelGeneratedSharedModule);

    const ZModel = inject(createDefaultModule({ shared }), ZModelGeneratedModule, ZModelModule);
    shared.ServiceRegistry.register(ZModel);
    return { shared, ZModel };
}
