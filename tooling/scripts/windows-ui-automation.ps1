param(
  [Parameter(Mandatory = $true)]
  [string]$SpecPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class OpappUiAutomationNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int command);

  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@

$spec = Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
$savedValues = @{}
$stepResults = @()
$artifacts = @()
$currentStep = $null
$currentStepIndex = -1
$currentStepLabel = $null
$legacyIAccessiblePatternType = [Type]::GetType(
  'System.Windows.Automation.LegacyIAccessiblePattern, UIAutomationClient',
  $false
)
$legacyIAccessiblePatternId = if ($null -ne $legacyIAccessiblePatternType) {
  $legacyIAccessiblePatternType.GetProperty('Pattern').GetValue($null, $null)
} else {
  $null
}

$controlTypeMap = @{
  'Button' = [System.Windows.Automation.ControlType]::Button
  'Edit' = [System.Windows.Automation.ControlType]::Edit
  'Pane' = [System.Windows.Automation.ControlType]::Pane
  'Text' = [System.Windows.Automation.ControlType]::Text
  'Window' = [System.Windows.Automation.ControlType]::Window
  'List' = [System.Windows.Automation.ControlType]::List
  'ListItem' = [System.Windows.Automation.ControlType]::ListItem
  'Custom' = [System.Windows.Automation.ControlType]::Custom
  'Document' = [System.Windows.Automation.ControlType]::Document
  'Tab' = [System.Windows.Automation.ControlType]::Tab
  'TabItem' = [System.Windows.Automation.ControlType]::TabItem
}

function Write-RunnerResult {
  param(
    [bool]$Ok,
    [hashtable]$Error = $null
  )

  $payload = @{
    ok = $Ok
    specName = if ($spec.name) { [string]$spec.name } else { 'windows-ui-automation' }
    savedValues = $savedValues
    steps = $stepResults
    artifacts = $artifacts
  }

  if ($null -ne $Error) {
    $payload.error = $Error
  }

  $json = $payload | ConvertTo-Json -Depth 100 -Compress
  Set-Content -LiteralPath $OutputPath -Value $json -Encoding UTF8
}

function Sanitize-ArtifactSegment {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return 'artifact'
  }

  $sanitized = [System.Text.RegularExpressions.Regex]::Replace(
    $Value,
    '[^a-zA-Z0-9._-]+',
    '-'
  ).Trim('-')

  if ([string]::IsNullOrWhiteSpace($sanitized)) {
    return 'artifact'
  }

  return $sanitized
}

function Get-ArtifactDirectory {
  $artifactDir = $null
  if ($null -ne $spec.debug) {
    $artifactDir = $spec.debug.artifactDir
  }
  if ([string]::IsNullOrWhiteSpace([string]$artifactDir)) {
    return $null
  }

  $resolvedArtifactDir = [System.IO.Path]::GetFullPath([string]$artifactDir)
  [System.IO.Directory]::CreateDirectory($resolvedArtifactDir) | Out-Null
  return $resolvedArtifactDir
}

function Add-ArtifactRecord {
  param(
    [string]$Kind,
    [string]$Path,
    [hashtable]$Metadata = @{}
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $null
  }

  $record = @{
    kind = $Kind
    path = $Path
  }

  foreach ($key in $Metadata.Keys) {
    if ($null -ne $Metadata[$key]) {
      $record[$key] = $Metadata[$key]
    }
  }

  $artifacts += $record
  return $record
}

function Get-RectangleFromBounds {
  param($Bounds)

  if ($null -eq $Bounds) {
    return $null
  }

  $left = [int][Math]::Floor($Bounds.Left)
  $top = [int][Math]::Floor($Bounds.Top)
  $width = [int][Math]::Ceiling($Bounds.Width)
  $height = [int][Math]::Ceiling($Bounds.Height)

  if ($width -le 0 -or $height -le 0) {
    return $null
  }

  return [System.Drawing.Rectangle]::FromLTRB(
    $left,
    $top,
    $left + $width,
    $top + $height
  )
}

function Get-ScreenCaptureBounds {
  param($Window)

  if ($null -ne $Window) {
    try {
      if ($Window.Current.NativeWindowHandle -ne 0) {
        $nativeRect = New-Object OpappUiAutomationNative+RECT
        $handle = [IntPtr]::new([int]$Window.Current.NativeWindowHandle)
        if (
          [OpappUiAutomationNative]::IsWindow($handle) -and
          [OpappUiAutomationNative]::GetWindowRect($handle, [ref]$nativeRect)
        ) {
          $width = $nativeRect.Right - $nativeRect.Left
          $height = $nativeRect.Bottom - $nativeRect.Top
          if ($width -gt 0 -and $height -gt 0) {
            return [System.Drawing.Rectangle]::FromLTRB(
              $nativeRect.Left,
              $nativeRect.Top,
              $nativeRect.Right,
              $nativeRect.Bottom
            )
          }
        }
      }
    } catch {
      # Fall back to the UIA bounding rectangle below.
    }

    try {
      $windowBounds = Get-RectangleFromBounds $Window.Current.BoundingRectangle
      if ($null -ne $windowBounds) {
        return $windowBounds
      }
    } catch {
      # Fall through to the primary screen fallback.
    }
  }

  return [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
}

function Save-RectangleScreenshot {
  param(
    [System.Drawing.Rectangle]$Bounds,
    [string]$DestinationPath
  )

  $bitmap = $null
  $graphics = $null

  try {
    $bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen(
      $Bounds.Left,
      $Bounds.Top,
      0,
      0,
      $Bounds.Size,
      [System.Drawing.CopyPixelOperation]::SourceCopy
    )
    $bitmap.Save($DestinationPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    if ($null -ne $graphics) {
      $graphics.Dispose()
    }
    if ($null -ne $bitmap) {
      $bitmap.Dispose()
    }
  }
}

function Get-StepCaptureRequested {
  param(
    [string]$StepType,
    $Step
  )

  if ($null -ne $Step.captureScreenshot) {
    return [bool]$Step.captureScreenshot
  }

  if ($null -ne $spec.debug -and $spec.debug.captureAfterActions) {
    return @('click', 'setValue', 'sendKeys') -contains $StepType
  }

  return $false
}

function Capture-StepScreenshot {
  param(
    [string]$Reason,
    [string]$StepType,
    [int]$StepIndex,
    [string]$StepLabel,
    $Step
  )

  $artifactDir = Get-ArtifactDirectory
  if ($null -eq $artifactDir) {
    return $null
  }

  try {
    $windowSpec = $null
    if ($null -ne $Step) {
      $windowSpec = Get-WindowSpec $Step
    }
    $window = $null
    if ($null -ne $windowSpec) {
      $window = Get-IndexedItem -Items (Get-Windows $windowSpec) -Index $Step.index
    }
    $captureBounds = Get-ScreenCaptureBounds $window
    if ($null -eq $captureBounds -or $captureBounds.Width -le 0 -or $captureBounds.Height -le 0) {
      return $null
    }

    $stepIndexSegment = 'na'
    if ($StepIndex -ge 0) {
      $stepIndexSegment = '{0:D2}' -f $StepIndex
    }
    $fileName = '{0}-{1}-{2}-{3}.png' -f (
      $stepIndexSegment
    ), (
      Sanitize-ArtifactSegment $Reason
    ), (
      Sanitize-ArtifactSegment $StepType
    ), (
      Sanitize-ArtifactSegment $StepLabel
    )
    $artifactPath = [System.IO.Path]::Combine($artifactDir, $fileName)
    Save-RectangleScreenshot -Bounds $captureBounds -DestinationPath $artifactPath
    return Add-ArtifactRecord -Kind 'screenshot' -Path $artifactPath -Metadata @{
      reason = $Reason
      stepIndex = $StepIndex
      stepLabel = $StepLabel
      stepType = $StepType
      width = $captureBounds.Width
      height = $captureBounds.Height
    }
  } catch {
    return $null
  }
}

function To-Array {
  param($Collection)

  $items = @()
  if ($null -eq $Collection) {
    return $items
  }

  if ($Collection -is [System.Array]) {
    return @($Collection)
  }

  for ($index = 0; $index -lt $Collection.Count; $index += 1) {
    $items += $Collection.Item($index)
  }

  return $items
}

function Resolve-ControlType {
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name)) {
    return $null
  }

  if (-not $controlTypeMap.ContainsKey($Name)) {
    throw "Unsupported controlType '$Name'."
  }

  return $controlTypeMap[$Name]
}

function Get-IndexedItem {
  param(
    [System.Array]$Items,
    $Index
  )

  $resolvedItems = @($Items)
  if ($resolvedItems.Count -eq 0) {
    return $null
  }

  $resolvedIndex = 0
  if ($null -ne $Index) {
    $resolvedIndex = [int]$Index
  }

  if ($resolvedIndex -lt 0) {
    $resolvedIndex = $resolvedItems.Count + $resolvedIndex
  }

  if ($resolvedIndex -lt 0 -or $resolvedIndex -ge $resolvedItems.Count) {
    return $null
  }

  return $resolvedItems[$resolvedIndex]
}

function Get-WindowSpec {
  param($Step)

  if ($null -ne $Step.window) {
    return $Step.window
  }

  return $null
}

function Get-Windows {
  param($WindowSpec)

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $children = To-Array ($root.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.Condition]::TrueCondition
    ))

  $windows = @(
    $children | Where-Object {
      try {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window
      } catch {
        $false
      }
    }
  )

  if ($null -eq $WindowSpec) {
    return $windows
  }

  if ($WindowSpec.title) {
    $expectedTitle = [string]$WindowSpec.title
    $windows = @(
      $windows | Where-Object {
        try {
          $_.Current.Name -eq $expectedTitle
        } catch {
          $false
        }
      }
    )
  }

  if ($WindowSpec.titleRegex) {
    $regex = [regex]([string]$WindowSpec.titleRegex)
    $windows = @(
      $windows | Where-Object {
        try {
          $regex.IsMatch([string]$_.Current.Name)
        } catch {
          $false
        }
      }
    )
  }

  if ($WindowSpec.className) {
    $expectedClassName = [string]$WindowSpec.className
    $windows = @(
      $windows | Where-Object {
        try {
          $_.Current.ClassName -eq $expectedClassName
        } catch {
          $false
        }
      }
    )
  }

  if ($WindowSpec.classNameRegex) {
    $classRegex = [regex]([string]$WindowSpec.classNameRegex)
    $windows = @(
      $windows | Where-Object {
        try {
          $classRegex.IsMatch([string]$_.Current.ClassName)
        } catch {
          $false
        }
      }
    )
  }

  return $windows
}

function Get-WindowSpecDescription {
  param($WindowSpec)

  if ($null -eq $WindowSpec) {
    return 'any top-level window'
  }

  $parts = @()
  if ($WindowSpec.title) {
    $parts += "title='$([string]$WindowSpec.title)'"
  }
  if ($WindowSpec.titleRegex) {
    $parts += "titleRegex='$([string]$WindowSpec.titleRegex)'"
  }
  if ($WindowSpec.className) {
    $parts += "className='$([string]$WindowSpec.className)'"
  }
  if ($WindowSpec.classNameRegex) {
    $parts += "classNameRegex='$([string]$WindowSpec.classNameRegex)'"
  }
  if ($parts.Count -eq 0) {
    return 'unqualified window selector'
  }

  return ($parts -join ', ')
}

function Get-UiRootChildren {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  return To-Array ($root.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.Condition]::TrueCondition
    ))
}

function Format-UiElementSnapshot {
  param([System.Windows.Automation.AutomationElement]$Element)

  try {
    $title = [string]$Element.Current.Name
    if (-not $title) {
      $title = '<empty>'
    }

    $typeName = [string]$Element.Current.ControlType.ProgrammaticName
    if (-not $typeName) {
      $typeName = '<unknown>'
    }

    $className = [string]$Element.Current.ClassName
    if (-not $className) {
      $className = '<none>'
    }

    $handle = [int]$Element.Current.NativeWindowHandle
    $processId = [int]$Element.Current.ProcessId

    return "title='$title', type=$typeName, class='$className', hwnd=$handle, pid=$processId"
  } catch {
    return "<unavailable: $($_.Exception.Message)>"
  }
}

function Get-WindowTimeoutDiagnostic {
  param($WindowSpec)

  $selector = Get-WindowSpecDescription $WindowSpec
  $matchingWindows = @(
    (Get-Windows $WindowSpec | Select-Object -First 8) | ForEach-Object {
      Format-UiElementSnapshot $_
    }
  )
  $rootChildren = @(
    (Get-UiRootChildren | Select-Object -First 16) | ForEach-Object {
      Format-UiElementSnapshot $_
    }
  )

  $matchingText = if ($matchingWindows.Count -gt 0) {
    $matchingWindows -join '; '
  } else {
    'none'
  }

  $rootChildrenText = if ($rootChildren.Count -gt 0) {
    $rootChildren -join '; '
  } else {
    'none'
  }

  return " Selector=$selector. Matching ControlType.Window nodes: $matchingText. Top-level UIA children: $rootChildrenText."
}

function Get-LocatorDescription {
  param($Locator)

  $parts = @()
  if ($Locator.automationId) {
    $parts += "automationId='$($Locator.automationId)'"
  }
  if ($Locator.name) {
    $parts += "name='$($Locator.name)'"
  }
  if ($Locator.nameRegex) {
    $parts += "nameRegex='$($Locator.nameRegex)'"
  }
  if ($Locator.controlType) {
    $parts += "controlType='$($Locator.controlType)'"
  }
  if ($parts.Count -eq 0) {
    return 'unqualified locator'
  }

  return ($parts -join ', ')
}

function Get-MatchingElements {
  param(
    [System.Windows.Automation.AutomationElement]$Container,
    $Locator
  )

  $searchScope = [System.Windows.Automation.TreeScope]::Descendants
  if ($Locator.scope -eq 'children') {
    $searchScope = [System.Windows.Automation.TreeScope]::Children
  }

  $elements = To-Array ($Container.FindAll(
      $searchScope,
      [System.Windows.Automation.Condition]::TrueCondition
    ))

  $targetControlType = Resolve-ControlType $Locator.controlType

  $matches = @(
    $elements | Where-Object {
      try {
        if ($Locator.automationId -and $_.Current.AutomationId -ne [string]$Locator.automationId) {
          return $false
        }

        if ($Locator.name -and $_.Current.Name -ne [string]$Locator.name) {
          return $false
        }

        if ($Locator.nameRegex) {
          $nameRegex = [regex]([string]$Locator.nameRegex)
          if (-not $nameRegex.IsMatch([string]$_.Current.Name)) {
            return $false
          }
        }

        if ($Locator.className -and $_.Current.ClassName -ne [string]$Locator.className) {
          return $false
        }

        if ($null -ne $targetControlType -and $_.Current.ControlType -ne $targetControlType) {
          return $false
        }

        return $true
      } catch {
        return $false
      }
    }
  )

  return $matches
}

function Resolve-Element {
  param($Step)

  if ($null -eq $Step.locator) {
    throw 'Missing locator on step.'
  }

  $windowSpec = Get-WindowSpec $Step
  $containers = if ($null -ne $windowSpec) {
    Get-Windows $windowSpec
  } else {
    @([System.Windows.Automation.AutomationElement]::RootElement)
  }

  if (@($containers).Count -eq 0) {
    return $null
  }

  $matches = @()
  foreach ($container in $containers) {
    $matches += Get-MatchingElements -Container $container -Locator $Step.locator
  }

  return Get-IndexedItem -Items $matches -Index $Step.locator.index
}

function Read-ElementText {
  param([System.Windows.Automation.AutomationElement]$Element)

  $textPattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
    return ($textPattern.DocumentRange.GetText(-1) -replace [char]0, '').Trim()
  }

  $valuePattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
    return [string]$valuePattern.Current.Value
  }

  if ($null -ne $legacyIAccessiblePatternId) {
    $legacyPattern = $null
    if ($Element.TryGetCurrentPattern($legacyIAccessiblePatternId, [ref]$legacyPattern)) {
      try {
        if ($legacyPattern.Current.Value) {
          return [string]$legacyPattern.Current.Value
        }
      } catch {
        # Some environments do not surface the legacy accessibility pattern consistently.
        # Fall through to the element name instead of failing the entire poll cycle.
      }
    }
  }

  return [string]$Element.Current.Name
}

function Get-NamedPropertyValue {
  param(
    $Object,
    [string]$Name
  )

  if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($Name)) {
    return $null
  }

  $property = $Object.PSObject.Properties | Where-Object { $_.Name -eq $Name } | Select-Object -First 1
  if ($null -eq $property) {
    return $null
  }

  return $property.Value
}

function Get-ControlTypeName {
  param([System.Windows.Automation.AutomationElement]$Element)

  try {
    $programmaticName = [string]$Element.Current.ControlType.ProgrammaticName
    if ($programmaticName -match '\.([^.]+)$') {
      return $Matches[1]
    }
  } catch {
    return $null
  }

  return $null
}

function Get-ElementState {
  param([System.Windows.Automation.AutomationElement]$Element)

  $state = @{
    automationId = [string]$Element.Current.AutomationId
    name = [string]$Element.Current.Name
    controlType = Get-ControlTypeName -Element $Element
    enabled = [bool]$Element.Current.IsEnabled
    focused = [bool]$Element.Current.HasKeyboardFocus
    offscreen = [bool]$Element.Current.IsOffscreen
  }

  $selectionPattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionPattern)) {
    try {
      $state.selected = [bool]$selectionPattern.Current.IsSelected
    } catch {
      # Some controls expose SelectionItemPattern but do not keep Current stable.
    }
  }

  $togglePattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$togglePattern)) {
    try {
      $state.toggled = [string]$togglePattern.Current.ToggleState.ToString()
    } catch {
      # Leave toggle state absent when the control reports inconsistently.
    }
  }

  return $state
}

function Test-StateMatcher {
  param(
    $State,
    $Matcher
  )

  if ($null -eq $Matcher) {
    return $true
  }

  $enabled = Get-NamedPropertyValue -Object $Matcher -Name 'enabled'
  $focused = Get-NamedPropertyValue -Object $Matcher -Name 'focused'
  $selected = Get-NamedPropertyValue -Object $Matcher -Name 'selected'
  $offscreen = Get-NamedPropertyValue -Object $Matcher -Name 'offscreen'
  $controlType = Get-NamedPropertyValue -Object $Matcher -Name 'controlType'
  $automationId = Get-NamedPropertyValue -Object $Matcher -Name 'automationId'
  $name = Get-NamedPropertyValue -Object $Matcher -Name 'name'
  $toggled = Get-NamedPropertyValue -Object $Matcher -Name 'toggled'

  if ($null -ne $enabled -and [bool]$State.enabled -ne [bool]$enabled) {
    return $false
  }

  if ($null -ne $focused -and [bool]$State.focused -ne [bool]$focused) {
    return $false
  }

  if ($null -ne $offscreen -and [bool]$State.offscreen -ne [bool]$offscreen) {
    return $false
  }

  if ($controlType -and [string]$State.controlType -ne [string]$controlType) {
    return $false
  }

  if ($automationId -and [string]$State.automationId -ne [string]$automationId) {
    return $false
  }

  if ($name -and [string]$State.name -ne [string]$name) {
    return $false
  }

  if ($null -ne $selected) {
    if (-not $State.ContainsKey('selected')) {
      return $false
    }
    if ([bool]$State.selected -ne [bool]$selected) {
      return $false
    }
  }

  if ($null -ne $toggled) {
    if (-not $State.ContainsKey('toggled')) {
      return $false
    }
    if ([string]$State.toggled -ne [string]$toggled) {
      return $false
    }
  }

  return $true
}

function Test-TextMatcher {
  param(
    [string]$Text,
    $Matcher
  )

  $candidateText = [string]$Text
  if ($null -eq $Matcher) {
    return $candidateText.Length -gt 0
  }

  $equals = Get-NamedPropertyValue -Object $Matcher -Name 'equals'
  $notEquals = Get-NamedPropertyValue -Object $Matcher -Name 'notEquals'
  $includes = Get-NamedPropertyValue -Object $Matcher -Name 'includes'
  $notIncludes = Get-NamedPropertyValue -Object $Matcher -Name 'notIncludes'
  $regexPattern = Get-NamedPropertyValue -Object $Matcher -Name 'regex'
  $notRegexPattern = Get-NamedPropertyValue -Object $Matcher -Name 'notRegex'
  $minLength = Get-NamedPropertyValue -Object $Matcher -Name 'minLength'

  if ($equals -and $candidateText -ne [string]$equals) {
    return $false
  }

  if ($notEquals -and $candidateText -eq [string]$notEquals) {
    return $false
  }

  if ($includes -and -not $candidateText.Contains([string]$includes)) {
    return $false
  }

  if ($notIncludes -and $candidateText.Contains([string]$notIncludes)) {
    return $false
  }

  if ($regexPattern) {
    $regex = [regex]([string]$regexPattern)
    if (-not $regex.IsMatch($candidateText)) {
      return $false
    }
  }

  if ($notRegexPattern) {
    $regex = [regex]([string]$notRegexPattern)
    if ($regex.IsMatch($candidateText)) {
      return $false
    }
  }

  if ($null -ne $minLength) {
    if ($candidateText.Length -lt [int]$minLength) {
      return $false
    }
  }

  return $true
}

function Wait-ForMatch {
  param(
    [scriptblock]$Probe,
    [int]$TimeoutMs,
    [int]$PollMs,
    [string]$FailureMessage
  )

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  $lastError = $null

  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $value = & $Probe
      if ($null -ne $value) {
        return $value
      }
    } catch {
      $lastError = $_.Exception.Message
    }

    Start-Sleep -Milliseconds $PollMs
  }

  if ($lastError) {
    throw "$FailureMessage Last error: $lastError"
  }

  throw $FailureMessage
}

function Focus-Window {
  param([System.Windows.Automation.AutomationElement]$Window)

  $handle = [IntPtr]$Window.Current.NativeWindowHandle
  if ($handle -eq [IntPtr]::Zero) {
    return
  }

  [void][OpappUiAutomationNative]::ShowWindowAsync($handle, 9)
  [void][OpappUiAutomationNative]::BringWindowToTop($handle)
  [void][OpappUiAutomationNative]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 120
}

function Invoke-Element {
  param([System.Windows.Automation.AutomationElement]$Element)

  $invokePattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {
    $invokePattern.Invoke()
    return
  }

  $selectionPattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionPattern)) {
    $selectionPattern.Select()
    Start-Sleep -Milliseconds 120
    try {
      if ($selectionPattern.Current.IsSelected) {
        return
      }
    } catch {
      # Fall through to keyboard activation when the selection state is not reliable.
    }

    $Element.SetFocus()
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait(' ')
    Start-Sleep -Milliseconds 120
    return
  }

  $togglePattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$togglePattern)) {
    $togglePattern.Toggle()
    return
  }

  if ($Element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) {
    $Element.SetFocus()
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait(' ')
    Start-Sleep -Milliseconds 120
    return
  }

  throw "Element does not support Invoke/Selection/Toggle patterns."
}

function Set-ElementValue {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$Value
  )

  $valuePattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
    if ($valuePattern.Current.IsReadOnly) {
      throw 'Element is read-only.'
    }

    $Element.SetFocus()
    $valuePattern.SetValue($Value)
    return
  }

  throw 'Element does not support ValuePattern.'
}

function Get-WindowMeasurement {
  param([System.Windows.Automation.AutomationElement]$Window)

  $handle = [IntPtr]$Window.Current.NativeWindowHandle
  if ($handle -eq [IntPtr]::Zero) {
    throw 'Window handle is unavailable.'
  }

  $rect = New-Object OpappUiAutomationNative+RECT
  $gotRect = [OpappUiAutomationNative]::GetWindowRect($handle, [ref]$rect)
  if (-not $gotRect) {
    throw 'GetWindowRect failed.'
  }

  $screen = [System.Windows.Forms.Screen]::FromHandle($handle)
  $workingArea = $screen.WorkingArea
  $title = [string]$Window.Current.Name

  return @{
    title = $title
    x = $rect.Left
    y = $rect.Top
    width = ($rect.Right - $rect.Left)
    height = ($rect.Bottom - $rect.Top)
    workArea = @{
      x = $workingArea.X
      y = $workingArea.Y
      width = $workingArea.Width
      height = $workingArea.Height
    }
  }
}

function Assert-WindowRectPolicy {
  param(
    [System.Windows.Automation.AutomationElement]$Window,
    $Geometry,
    $TolerancePx
  )

  $measurement = Get-WindowMeasurement -Window $Window
  $workArea = $measurement.workArea
  $maxWidth = [Math]::Max(900, [int]$workArea.width - 48)
  $maxHeight = [Math]::Max(720, [int]$workArea.height - 48)
  $minWidth = [Math]::Min([int]$Geometry.minWidth, $maxWidth)
  $expectedWidth = [Math]::Min(
    [Math]::Max([Math]::Truncate([double]$workArea.width * [double]$Geometry.widthFactor), $minWidth),
    $maxWidth
  )
  $minHeight = [Math]::Min([int]$Geometry.minHeight, $maxHeight)
  $expectedHeight = [Math]::Min(
    [Math]::Max([Math]::Truncate([double]$expectedWidth * [double]$Geometry.aspectRatio), $minHeight),
    $maxHeight
  )
  $tolerance = if ($null -ne $TolerancePx) { [int]$TolerancePx } else { 2 }

  if ([Math]::Abs([int]$measurement.width - $expectedWidth) -gt $tolerance) {
    return $null
  }

  if ([Math]::Abs([int]$measurement.height - $expectedHeight) -gt $tolerance) {
    return $null
  }

  $measurement.expected = @{
    width = $expectedWidth
    height = $expectedHeight
    tolerancePx = $tolerance
  }

  return $measurement
}

function Get-StepTimeoutMs {
  param($Step)

  if ($null -ne $Step.timeoutMs) {
    return [int]$Step.timeoutMs
  }

  if ($null -ne $spec.defaultTimeoutMs) {
    return [int]$spec.defaultTimeoutMs
  }

  return 5000
}

function Get-StepPollMs {
  param($Step)

  if ($null -ne $Step.pollMs) {
    return [int]$Step.pollMs
  }

  if ($null -ne $spec.pollMs) {
    return [int]$spec.pollMs
  }

  return 200
}

try {
  $steps = @($spec.steps)
  for ($stepIndex = 0; $stepIndex -lt $steps.Count; $stepIndex += 1) {
    $step = $steps[$stepIndex]
    $stepLabel = if ($step.label) { [string]$step.label } else { "step-$stepIndex" }
    $stepType = [string]$step.type
    $timeoutMs = Get-StepTimeoutMs -Step $step
    $pollMs = Get-StepPollMs -Step $step
    $stepStart = Get-Date
    $stepOutput = $null
    $currentStep = $step
    $currentStepIndex = $stepIndex
    $currentStepLabel = $stepLabel
    $stepArtifacts = @()

    switch ($stepType) {
      'waitWindow' {
        $windowSpec = Get-WindowSpec $step
        if ($null -eq $windowSpec) {
          throw 'waitWindow requires a window selector.'
        }

        try {
          $stepOutput = Wait-ForMatch -TimeoutMs $timeoutMs -PollMs $pollMs -FailureMessage "Timed out waiting for window." -Probe {
            $window = Get-IndexedItem -Items (Get-Windows $windowSpec) -Index $step.index
            if ($null -eq $window) {
              return $null
            }

            if ($step.focus) {
              Focus-Window -Window $window
            }

            return Get-WindowMeasurement -Window $window
          }
        } catch {
          throw "$($_.Exception.Message)$(Get-WindowTimeoutDiagnostic $windowSpec)"
        }
      }
      'assertWindowCount' {
        $windowSpec = Get-WindowSpec $step
        if ($null -eq $windowSpec) {
          throw 'assertWindowCount requires a window selector.'
        }

        $expectedCount = [int]$step.expectedCount
        try {
          $stepOutput = Wait-ForMatch -TimeoutMs $timeoutMs -PollMs $pollMs -FailureMessage "Timed out waiting for window count $expectedCount." -Probe {
            $count = @(Get-Windows $windowSpec).Count
            if ($count -ne $expectedCount) {
              return $null
            }

            return @{
              count = $count
            }
          }
        } catch {
          throw "$($_.Exception.Message)$(Get-WindowTimeoutDiagnostic $windowSpec)"
        }
      }
      'focusWindow' {
        $windowSpec = Get-WindowSpec $step
        if ($null -eq $windowSpec) {
          throw 'focusWindow requires a window selector.'
        }

        try {
          $stepOutput = Wait-ForMatch -TimeoutMs $timeoutMs -PollMs $pollMs -FailureMessage "Timed out focusing window." -Probe {
            $window = Get-IndexedItem -Items (Get-Windows $windowSpec) -Index $step.index
            if ($null -eq $window) {
              return $null
            }

            Focus-Window -Window $window
            return Get-WindowMeasurement -Window $window
          }
        } catch {
          throw "$($_.Exception.Message)$(Get-WindowTimeoutDiagnostic $windowSpec)"
        }
      }
      'sendKeys' {
        $windowSpec = Get-WindowSpec $step
        $keys = [string]$step.keys
        if ([string]::IsNullOrWhiteSpace($keys)) {
          throw 'sendKeys requires a keys payload.'
        }

        $delayMs = if ($null -ne $step.delayMs) {
          [int]$step.delayMs
        } else {
          150
        }

        $stepOutput = Wait-ForMatch -TimeoutMs $timeoutMs -PollMs $pollMs -FailureMessage "Timed out waiting to send keys '$keys'." -Probe {
          if ($null -ne $windowSpec) {
            $window = Get-IndexedItem -Items (Get-Windows $windowSpec) -Index $step.index
            if ($null -eq $window) {
              return $null
            }

            Focus-Window -Window $window
          }

          [System.Windows.Forms.SendKeys]::SendWait($keys)
          Start-Sleep -Milliseconds $delayMs
          return @{
            keys = $keys
          }
        }
      }
      'waitElement' {
        $locatorDescription = Get-LocatorDescription $step.locator
        $stepOutput = Wait-ForMatch -TimeoutMs $timeoutMs -PollMs $pollMs -FailureMessage "Timed out waiting for element: $locatorDescription." -Probe {
          $element = Resolve-Element -Step $step
          if ($null -eq $element) {
            return $null
          }

          return @{
            text = Read-ElementText -Element $element
          }
        }
      }
      'readElementState' {
        $locatorDescription = Get-LocatorDescription $step.locator
        $stepOutput = Wait-ForMatch -TimeoutMs $timeoutMs -PollMs $pollMs -FailureMessage "Timed out waiting to read element state: $locatorDescription." -Probe {
          $element = Resolve-Element -Step $step
          if ($null -eq $element) {
            return $null
          }

          return Get-ElementState -Element $element
        }
      }
      'waitElementState' {
        $locatorDescription = Get-LocatorDescription $step.locator
        $lastObservedState = $null
        try {
          $stepOutput = Wait-ForMatch -TimeoutMs $timeoutMs -PollMs $pollMs -FailureMessage "Timed out waiting for matching element state: $locatorDescription." -Probe {
            $element = Resolve-Element -Step $step
            if ($null -eq $element) {
              return $null
            }

            $state = Get-ElementState -Element $element
            $lastObservedState = $state
            if (-not (Test-StateMatcher -State $state -Matcher $step.matcher)) {
              return $null
            }

            return $state
          }
        } catch {
          $diagnostic = if ($null -ne $lastObservedState) {
            " Last observed state: $((ConvertTo-Json $lastObservedState -Compress))."
          } else {
            ''
          }
          throw "$($_.Exception.Message)$diagnostic"
        }
      }
      'click' {
        $locatorDescription = Get-LocatorDescription $step.locator
        $stepOutput = Wait-ForMatch -TimeoutMs $timeoutMs -PollMs $pollMs -FailureMessage "Timed out waiting to click element: $locatorDescription." -Probe {
          $element = Resolve-Element -Step $step
          if ($null -eq $element) {
            return $null
          }

          $windowSpec = Get-WindowSpec $step
          if ($null -ne $windowSpec) {
            $window = Get-IndexedItem -Items (Get-Windows $windowSpec) -Index $step.index
            if ($null -ne $window) {
              Focus-Window -Window $window
            }
          }

          Invoke-Element -Element $element
          Start-Sleep -Milliseconds 150
          return @{
            text = Read-ElementText -Element $element
          }
        }
      }
      'setValue' {
        $locatorDescription = Get-LocatorDescription $step.locator
        $targetValue = [string]$step.value
        $stepOutput = Wait-ForMatch -TimeoutMs $timeoutMs -PollMs $pollMs -FailureMessage "Timed out waiting to set value on element: $locatorDescription." -Probe {
          $element = Resolve-Element -Step $step
          if ($null -eq $element) {
            return $null
          }

          Set-ElementValue -Element $element -Value $targetValue
          $nextValue = Read-ElementText -Element $element
          if ($nextValue -ne $targetValue) {
            return $null
          }

          return @{
            value = $nextValue
          }
        }
      }
      'readText' {
        $locatorDescription = Get-LocatorDescription $step.locator
        $stepOutput = Wait-ForMatch -TimeoutMs $timeoutMs -PollMs $pollMs -FailureMessage "Timed out waiting to read element text: $locatorDescription." -Probe {
          $element = Resolve-Element -Step $step
          if ($null -eq $element) {
            return $null
          }

          return @{
            text = Read-ElementText -Element $element
          }
        }
      }
      'waitText' {
        $locatorDescription = Get-LocatorDescription $step.locator
        $lastObservedText = $null
        try {
          $stepOutput = Wait-ForMatch -TimeoutMs $timeoutMs -PollMs $pollMs -FailureMessage "Timed out waiting for matching text on element: $locatorDescription." -Probe {
            $element = Resolve-Element -Step $step
            if ($null -eq $element) {
              return $null
            }

            $text = Read-ElementText -Element $element
            $lastObservedText = $text
            if (-not (Test-TextMatcher -Text $text -Matcher $step.matcher)) {
              return $null
            }

            return @{
              text = $text
            }
          }
        } catch {
          $diagnostic = if ($null -ne $lastObservedText) {
            " Last observed text: '$lastObservedText'."
          } else {
            ''
          }
          throw "$($_.Exception.Message)$diagnostic"
        }
      }
      'assertElementMissing' {
        $stepOutput = Wait-ForMatch -TimeoutMs $timeoutMs -PollMs $pollMs -FailureMessage "Timed out waiting for element to disappear." -Probe {
          $element = Resolve-Element -Step $step
          if ($null -ne $element) {
            return $null
          }

          return @{
            missing = $true
          }
        }
      }
      'assertWindowRectPolicy' {
        $windowSpec = Get-WindowSpec $step
        if ($null -eq $windowSpec) {
          throw 'assertWindowRectPolicy requires a window selector.'
        }
        if ($null -eq $step.geometry) {
          throw 'assertWindowRectPolicy requires geometry.'
        }

        $stepOutput = Wait-ForMatch -TimeoutMs $timeoutMs -PollMs $pollMs -FailureMessage "Timed out waiting for window rect policy match." -Probe {
          $window = Get-IndexedItem -Items (Get-Windows $windowSpec) -Index $step.index
          if ($null -eq $window) {
            return $null
          }

          Assert-WindowRectPolicy -Window $window -Geometry $step.geometry -TolerancePx $step.tolerancePx
        }
      }
      'sleep' {
        Start-Sleep -Milliseconds $timeoutMs
        $stepOutput = @{
          sleptMs = $timeoutMs
        }
      }
      default {
        throw "Unsupported step type '$stepType'."
      }
    }

    if (Get-StepCaptureRequested -StepType $stepType -Step $step) {
      $capturedArtifact = Capture-StepScreenshot -Reason 'after-step' -StepType $stepType -StepIndex $stepIndex -StepLabel $stepLabel -Step $step
      if ($null -ne $capturedArtifact) {
        $stepArtifacts += $capturedArtifact
      }
    }

    if ($step.saveAs) {
      if ($stepOutput -is [hashtable] -and $stepOutput.ContainsKey('text')) {
        $savedValues[[string]$step.saveAs] = [string]$stepOutput.text
      } else {
        $savedValues[[string]$step.saveAs] = $stepOutput
      }
    }

    $durationMs = [int]((Get-Date) - $stepStart).TotalMilliseconds
    $stepResults += @{
      index = $stepIndex
      label = $stepLabel
      type = $stepType
      durationMs = $durationMs
    }
    if ($stepArtifacts.Count -gt 0) {
      $stepResults[-1].artifacts = @($stepArtifacts)
    }
  }

  Write-RunnerResult -Ok $true
  exit 0
} catch {
  $message = $_.Exception.Message
  $failureArtifacts = @()
  if ($null -ne $spec.debug -and $spec.debug.captureOnFailure) {
    $failureStepType = 'unknown'
    if ($null -ne $currentStep) {
      $failureStepType = [string]$currentStep.type
    }
    $capturedArtifact = Capture-StepScreenshot -Reason 'failure' -StepType $failureStepType -StepIndex $currentStepIndex -StepLabel $currentStepLabel -Step $currentStep
    if ($null -ne $capturedArtifact) {
      $failureArtifacts += $capturedArtifact
    }
  }
  Write-RunnerResult -Ok $false -Error @{
    message = $message
    stepCount = $stepResults.Count
    artifacts = @($failureArtifacts)
  }
  Write-Error $message
  exit 1
}
