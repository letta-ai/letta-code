export type SlackFileLike = {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

export type SlackAttachmentReadClient = {
  conversations: {
    history(args: {
      channel: string;
      latest?: string;
      oldest?: string;
      limit?: number;
      inclusive?: boolean;
    }): Promise<unknown>;
    replies(args: {
      channel: string;
      ts: string;
      limit?: number;
      inclusive?: boolean;
      cursor?: string;
    }): Promise<unknown>;
  };
};
