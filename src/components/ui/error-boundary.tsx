"use client";

import React, { Component, type ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "./button";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  fallbackMessage?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[COMPONENT_ERROR_BOUNDARY_CAUGHT]", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-1 flex-col items-center justify-center p-6 text-center bg-card/50">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive mb-3">
            <AlertCircle className="h-6 w-6" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">
            {this.props.fallbackTitle || "Falha ao exibir este painel"}
          </h3>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground leading-relaxed">
            {this.state.error?.message ||
              this.props.fallbackMessage ||
              "Ocorreu um erro inesperado neste componente."}
          </p>
          <Button
            onClick={this.handleReset}
            size="sm"
            variant="outline"
            className="mt-4 gap-2 text-xs cursor-pointer"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Recarregar visualização
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
