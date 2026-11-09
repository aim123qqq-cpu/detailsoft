import type { ComponentRef, Ref } from 'react';
import { Text as NativeText, TextInput as NativeTextInput, type TextInputProps, type TextProps } from 'react-native';
import { font, useTheme } from '@/lib/theme';

// Every text of the app in Manrope and, unless a screen says otherwise, in the ink of the current theme.

export function Text({ style, ref, ...props }: TextProps & { ref?: Ref<ComponentRef<typeof NativeText>> }) {
  const { colors } = useTheme();
  return <NativeText ref={ref} {...props} style={[{ fontFamily: font, color: colors.ink }, style]}/>;
}

export function TextInput({ style, ref, ...props }: TextInputProps & { ref?: Ref<ComponentRef<typeof NativeTextInput>> }) {
  const { colors } = useTheme();
  return <NativeTextInput ref={ref} placeholderTextColor={colors.muted} selectionColor={colors.accent} cursorColor={colors.accent} {...props}
    style={[{ fontFamily: font, color: colors.ink }, style]}/>;
}
