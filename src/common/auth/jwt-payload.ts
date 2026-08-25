import { Role } from '@prisma/client';

/** Shape of the signed JWT access-token payload (PRD §5.1). */
export interface JwtPayload {
  sub: string; // userId
  role: Role;
  isApproved: boolean;
  type: 'access';
}

/** The authenticated principal attached to `req.user` by the JWT guard. */
export interface AuthUser {
  userId: string;
  role: Role;
  isApproved: boolean;
}
