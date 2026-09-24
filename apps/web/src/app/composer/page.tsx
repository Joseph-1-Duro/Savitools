import { SiteHeader } from '@/components/layout/site-header';
import { ComposerTool } from '@/components/tools/other-tools';
import { ToolPageShell } from '@/components/tools/tool-page-shell';
import { ErrorBoundary } from '@/components/tools/error-boundary';

export default function ComposerPage() {
  return (
    <>
      <SiteHeader />
      <ToolPageShell
        title="Transaction Composer"
        description="Visual builder for multi-operation Stellar transactions."
        docsHref="/docs/composer"
      >
        <ErrorBoundary toolName="Composer">
          <ComposerTool />
        </ErrorBoundary>
      </ToolPageShell>
    </>
  );
}
